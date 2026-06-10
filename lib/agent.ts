import path from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  addTextOverlays,
  concat,
  detectScenes,
  probe,
  trim,
  type ProbeResult,
  type Transition,
} from "./ffmpeg";
import { renderTitleCard } from "./remotion";
import {
  emit,
  getReference,
  listFootage,
  log,
  outputPath,
  referenceUrlFile,
  setJobMeta,
  setStatus,
  workspaceDirs,
} from "./jobs";
import { downloadYouTubeVideo } from "./youtube";
import { readFile } from "node:fs/promises";

const SERVER_NAME = "editor";

function withinWorkspace(jobId: string, p: string): string {
  const dirs = workspaceDirs(jobId);
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(dirs.root))) {
    throw new Error(`Path ${p} escapes job workspace`);
  }
  return resolved;
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

function err(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function summarizeProbe(p: ProbeResult) {
  return {
    path: p.path,
    duration_s: Number(p.duration.toFixed(2)),
    width: p.width,
    height: p.height,
    fps: Number(p.fps.toFixed(2)),
    has_audio: p.hasAudio,
    codec: p.videoCodec,
  };
}

function buildEditorServer(jobId: string) {
  const dirs = workspaceDirs(jobId);

  const list_footage = tool(
    "list_footage",
    "List the paths of all uploaded footage clips for this job. Returns absolute file paths.",
    {},
    async () => {
      try {
        const items = await listFootage(jobId);
        emit(jobId, {
          type: "tool_result",
          tool: "list_footage",
          ok: true,
          summary: `${items.length} clips`,
          at: Date.now(),
        });
        return ok({ clips: items });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const get_reference = tool(
    "get_reference",
    "Get the absolute path of the reference/style video, or null if none was uploaded.",
    {},
    async () => {
      const ref = await getReference(jobId);
      emit(jobId, {
        type: "tool_result",
        tool: "get_reference",
        ok: true,
        summary: ref ? "reference present" : "no reference",
        at: Date.now(),
      });
      return ok({ reference: ref });
    },
  );

  const probe_clip = tool(
    "probe_clip",
    "Run ffprobe on a video file and return duration, resolution, fps, codec, and audio presence.",
    { path: z.string().describe("Absolute path inside this job's workspace") },
    async ({ path: p }) => {
      try {
        const abs = withinWorkspace(jobId, p);
        emit(jobId, { type: "tool", tool: "probe_clip", input: { path: p }, at: Date.now() });
        const r = await probe(abs);
        const summary = summarizeProbe(r);
        emit(jobId, {
          type: "tool_result",
          tool: "probe_clip",
          ok: true,
          summary: `${path.basename(abs)} ${r.width}x${r.height} ${r.duration.toFixed(1)}s`,
          at: Date.now(),
        });
        return ok(summary);
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const detect_scenes_tool = tool(
    "detect_scenes",
    "Detect scene-change timestamps (seconds) in a clip using ffmpeg's scene filter. Useful for picking visually interesting cut points.",
    {
      path: z.string(),
      threshold: z
        .number()
        .min(0.05)
        .max(0.9)
        .default(0.35)
        .describe("Sensitivity 0-1; lower = more scenes"),
    },
    async ({ path: p, threshold }) => {
      try {
        const abs = withinWorkspace(jobId, p);
        emit(jobId, {
          type: "tool",
          tool: "detect_scenes",
          input: { path: p, threshold },
          at: Date.now(),
        });
        const scenes = await detectScenes(abs, threshold);
        emit(jobId, {
          type: "tool_result",
          tool: "detect_scenes",
          ok: true,
          summary: `${scenes.length} scene changes in ${path.basename(abs)}`,
          at: Date.now(),
        });
        return ok({ scene_times_s: scenes });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const trim_clip = tool(
    "trim_clip",
    "Extract a sub-clip from a source video by start time and duration (seconds). Writes to the job's clips/ directory and returns the new file's path.",
    {
      source: z.string().describe("Absolute path to a clip in this job's workspace"),
      start_s: z.number().min(0),
      duration_s: z.number().min(0.2).max(60),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Filename stem (no extension), e.g. 'clip_01'"),
    },
    async ({ source, start_s, duration_s, name }) => {
      try {
        const abs = withinWorkspace(jobId, source);
        const out = path.join(dirs.clips, `${name}.mp4`);
        emit(jobId, {
          type: "tool",
          tool: "trim_clip",
          input: { source, start_s, duration_s, name },
          at: Date.now(),
        });
        await trim(abs, out, start_s, duration_s);
        await stat(out);
        emit(jobId, {
          type: "tool_result",
          tool: "trim_clip",
          ok: true,
          summary: `${name}.mp4 (${duration_s.toFixed(1)}s from ${path.basename(abs)}@${start_s.toFixed(1)}s)`,
          at: Date.now(),
        });
        return ok({ path: out });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const TRANSITION_TYPES = [
    "fade",
    "fadeblack",
    "fadewhite",
    "wipeleft",
    "wiperight",
    "wipeup",
    "wipedown",
    "slideleft",
    "slideright",
    "dissolve",
    "smoothleft",
    "smoothright",
    "circleopen",
    "circleclose",
  ] as const;

  const add_text_overlay = tool(
    "add_text_overlay",
    "Burn one or more text overlays into a clip (title cards, labels, captions). Produces a new clip in the clips/ directory and returns its path. Coordinates: overlays are full-width and horizontally centered; position selects vertical placement; start_s/duration_s are relative to the clip's own timeline (the input is typically a clip from trim_clip, ~1.5-6s long).",
    {
      source: z.string().describe("Absolute path to a clip in this job's workspace"),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Output filename stem, e.g. 'clip_01_titled'"),
      overlays: z
        .array(
          z.object({
            text: z.string().min(1).max(120),
            position: z.enum(["top", "center", "bottom"]),
            start_s: z.number().min(0),
            duration_s: z.number().min(0.2).max(30),
            font_size: z
              .number()
              .int()
              .min(12)
              .max(240)
              .optional()
              .describe("Pixel size; defaults to ~7% of clip height"),
            color: z
              .string()
              .regex(/^#[0-9a-fA-F]{6}$/)
              .optional()
              .describe("Hex color like #FFFFFF; default white"),
          }),
        )
        .min(1)
        .max(6),
    },
    async ({ source, name, overlays }) => {
      try {
        const abs = withinWorkspace(jobId, source);
        const out = path.join(dirs.clips, `${name}.mp4`);
        emit(jobId, {
          type: "tool",
          tool: "add_text_overlay",
          input: { source, name, count: overlays.length },
          at: Date.now(),
        });
        await addTextOverlays(abs, out, overlays);
        await stat(out);
        emit(jobId, {
          type: "tool_result",
          tool: "add_text_overlay",
          ok: true,
          summary: `${name}.mp4 with ${overlays.length} overlay${overlays.length === 1 ? "" : "s"}`,
          at: Date.now(),
        });
        return ok({ path: out });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const render_title_card = tool(
    "render_title_card",
    "Render an animated motion-graphics title card (intro or outro) as a standalone MP4 clip via Remotion. The card animates in with a spring-driven title, an accent bar, an optional uppercase subtitle, and a slow gradient background. Use this for a polished opening or closing beat. Match `width`/`height`/`fps` to your target edit so it composes cleanly. Returns the new clip's path — include it as the first (intro) or last (outro) entry in assemble_edit's clips list.",
    {
      kind: z.enum(["intro", "outro"]),
      text: z.string().min(1).max(80).describe("Main title — 1-5 words reads best"),
      subtitle: z
        .string()
        .max(80)
        .optional()
        .describe("Optional small line below; rendered uppercase. Leave empty when not needed."),
      theme: z
        .enum(["minimal", "bold", "cinematic"])
        .describe(
          "minimal = dark mono, modern; bold = vibrant pink→blue gradient, all caps; cinematic = navy with gold accent",
        ),
      duration_s: z.number().min(1).max(8).default(3),
      width: z.number().int().min(64).max(7680),
      height: z.number().int().min(64).max(4320),
      fps: z.number().int().min(15).max(60).default(30),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Output filename stem, e.g. 'intro' or 'outro_card'"),
    },
    async ({ kind, text, subtitle, theme, duration_s, width, height, fps, name }) => {
      try {
        const out = path.join(dirs.clips, `${name}.mp4`);
        emit(jobId, {
          type: "tool",
          tool: "render_title_card",
          input: { kind, text, subtitle, theme, duration_s, width, height, fps, name },
          at: Date.now(),
        });
        await renderTitleCard(
          out,
          { text, subtitle, theme, kind, width, height, duration_s, fps },
          (msg) => log(jobId, "info", msg),
        );
        await stat(out);
        emit(jobId, {
          type: "tool_result",
          tool: "render_title_card",
          ok: true,
          summary: `${name}.mp4 (${kind} ${theme} "${text}", ${duration_s}s @ ${width}x${height})`,
          at: Date.now(),
        });
        return ok({ path: out });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const assemble_edit = tool(
    "assemble_edit",
    "Concatenate trimmed clips in order into the final edited video at output/final.mp4. All clips are normalized to the given resolution and 30fps. If `transition` is set, consecutive clips are joined with that xfade transition (and audio cross-fades over the same duration). Call this exactly once when the edit is ready.",
    {
      clips: z
        .array(z.string())
        .min(1)
        .describe("Ordered list of clip paths (from trim_clip or add_text_overlay), in playback order"),
      target_width: z.number().int().min(64).max(7680),
      target_height: z.number().int().min(64).max(4320),
      transition: z
        .object({
          type: z.enum(TRANSITION_TYPES),
          duration_s: z
            .number()
            .min(0.15)
            .max(2.5)
            .describe("Crossfade duration in seconds; will be clamped to ~45% of the shorter neighbor clip"),
        })
        .optional()
        .describe("If omitted, clips are joined with hard cuts"),
      note: z.string().optional().describe("Brief description of the edit decisions"),
    },
    async ({ clips, target_width, target_height, transition, note }) => {
      try {
        for (const c of clips) withinWorkspace(jobId, c);
        const out = outputPath(jobId);
        emit(jobId, {
          type: "tool",
          tool: "assemble_edit",
          input: {
            count: clips.length,
            target_width,
            target_height,
            transition,
            note,
          },
          at: Date.now(),
        });
        await concat(
          clips,
          out,
          target_width,
          target_height,
          30,
          transition as Transition | undefined,
        );
        await stat(out);
        setJobMeta(jobId, { outputAvailable: true });
        const transitionSuffix = transition
          ? ` with ${transition.type} ${transition.duration_s}s transitions`
          : " (hard cuts)";
        emit(jobId, {
          type: "tool_result",
          tool: "assemble_edit",
          ok: true,
          summary: `final.mp4 from ${clips.length} clips at ${target_width}x${target_height}${transitionSuffix}`,
          at: Date.now(),
        });
        return ok({ output: out });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const note = tool(
    "note",
    "Record a short human-readable note about your editing reasoning. Use this to narrate decisions; it's surfaced to the user.",
    { message: z.string().max(500) },
    async ({ message }) => {
      log(jobId, "info", `Agent: ${message}`);
      return ok({ recorded: true });
    },
  );

  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.1.0",
    instructions:
      "Custom editing tools that operate on this job's workspace only. Always use probe_clip on every footage before deciding cuts.",
    tools: [
      list_footage,
      get_reference,
      probe_clip,
      detect_scenes_tool,
      trim_clip,
      add_text_overlay,
      render_title_card,
      assemble_edit,
      note,
    ],
  });
}

const SYSTEM_PROMPT = `You are an autonomous video editor agent.

Your goal: given a folder of raw footage and an optional reference/style video, produce one edited highlight video at output/final.mp4 that captures the most interesting moments and roughly matches the reference's pacing and aspect ratio.

Workflow you must follow:
1. Call list_footage and get_reference to see what you have.
2. Call probe_clip on every footage clip AND the reference (if present). Record durations, resolutions, fps.
3. Choose target_width and target_height:
   - If a reference exists, match its resolution.
   - Otherwise use the most common resolution among footage clips. Default to 1920x1080 if all else fails.
4. If a reference exists, call detect_scenes on it to estimate the reference's pacing and feel:
   - Average shot length = mean gap between scene times. Target this length, clamped to [1.5s, 6s]. Without a reference, target 3s shots.
   - Reference energy: many scene changes → energetic (favor harder cuts), few scene changes → contemplative (favor crossfades).
5. For each footage clip, call detect_scenes to find candidate cut points. Pick 1-4 interesting segments per clip (avoid the first 0.5s and last 0.5s; ensure segments don't overlap). If detect_scenes returns few or no times, sample every ~target_shot_length seconds instead.
6. Call trim_clip for each chosen segment using your target shot length as duration_s. Name them clip_01, clip_02, ... in playback order. Aim for 6-20 trimmed clips total, and a final runtime of 20-90 seconds.
7. Optionally add titles. You have TWO options — pick what fits:
   a. STATIC text burned on top of a footage clip via add_text_overlay — best for lower-thirds, locations, brief labels mid-video. Returns a new clip path; use IT (not the original) in assemble_edit.
   b. ANIMATED motion-graphics title card via render_title_card — best for a polished opener or closer. This produces its own standalone clip (no footage underneath). Title text 1-5 words; pick a theme that matches the reference's mood: "minimal" for neutral/contemplative, "bold" for energetic/social-media, "cinematic" for slow/atmospheric. Duration 2-3.5s. Match width/height/fps to your target_edit. Then add the returned clip as the FIRST (intro) or LAST (outro) entry in assemble_edit's clips list.
   - You can use both (a tasteful intro card + a mid-clip lower-third). Skip titles entirely if nothing meaningful to add.
8. Choose an ordering that feels good (chronological per source, or grouped by visual energy; you decide). If you rendered an intro card, it goes first; outro goes last.
9. Call assemble_edit ONCE with the ordered clip paths and target resolution. Pick a transition:
   - Energetic / many scene changes → omit transition (hard cuts) or use a short fade (0.25s).
   - Contemplative / few scene changes → use "fade" or "dissolve" at 0.5-0.8s.
   - For a bold opener, "fadeblack" works well.
   - When unsure, default to fade at 0.4s. Include a one-sentence note describing your edit decisions.
10. After assemble_edit succeeds, reply with a single sentence summarizing the result and stop. Do not call any more tools.

Use the note tool sparingly to explain non-obvious choices. Be decisive — don't ask for clarification, and don't loop forever. If a tool errors, log it via note and try once more with adjusted inputs, then move on.`;

export async function runEditorAgent(jobId: string): Promise<void> {
  setStatus(jobId, "running");
  log(jobId, "info", "Agent starting…");

  // If a YouTube URL was provided as the reference, fetch it first.
  let urlContents: string | null = null;
  try {
    urlContents = (await readFile(referenceUrlFile(jobId), "utf8")).trim();
  } catch {
    urlContents = null;
  }
  if (urlContents) {
    log(jobId, "info", `Downloading reference video from ${urlContents}…`);
    const dirs = workspaceDirs(jobId);
    const out = path.join(dirs.reference, "youtube.mp4");
    try {
      const meta = await downloadYouTubeVideo(urlContents, out, {
        onProgress: (line) => {
          // yt-dlp can be chatty; surface the most useful lines without flooding.
          if (
            /Destination|Merging|has already been downloaded|ERROR|Downloading 1 format/.test(line)
          ) {
            log(jobId, "info", `yt-dlp: ${line}`);
          }
        },
        timeoutMs: 4 * 60_000,
      });
      log(
        jobId,
        "info",
        `Reference downloaded: "${meta.title}"${meta.uploader ? ` by ${meta.uploader}` : ""} (${meta.durationSeconds.toFixed(1)}s)`,
      );
      setJobMeta(jobId, { hasReference: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setJobMeta(jobId, { error: `YouTube download failed: ${msg}` });
      log(jobId, "error", `YouTube download failed: ${msg}`);
      setStatus(jobId, "failed");
      emit(jobId, { type: "done", outputPath: null, at: Date.now() });
      return;
    }
  }

  const footage = await listFootage(jobId);
  const ref = await getReference(jobId);
  setJobMeta(jobId, { footageCount: footage.length, hasReference: !!ref });

  if (footage.length === 0) {
    setJobMeta(jobId, { error: "No footage uploaded" });
    setStatus(jobId, "failed");
    emit(jobId, { type: "done", outputPath: null, at: Date.now() });
    return;
  }

  const mcp = buildEditorServer(jobId);
  const dirs = workspaceDirs(jobId);
  const allowed = [
    "list_footage",
    "get_reference",
    "probe_clip",
    "detect_scenes",
    "trim_clip",
    "add_text_overlay",
    "render_title_card",
    "assemble_edit",
    "note",
  ].map((n) => `mcp__${SERVER_NAME}__${n}`);

  const userPrompt = [
    `Job workspace: ${dirs.root}`,
    `Footage count: ${footage.length}`,
    `Reference video: ${ref ? "yes" : "no"}`,
    "",
    "Begin the edit now. Follow the workflow exactly.",
  ].join("\n");

  try {
    const q = query({
      prompt: userPrompt,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { [SERVER_NAME]: mcp },
        tools: [],
        allowedTools: allowed,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: dirs.root,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "video-editor/0.1" },
      },
    });

    for await (const msg of q) {
      if (msg.type === "assistant") {
        const blocks = msg.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "text" && b.text.trim()) {
            emit(jobId, { type: "assistant", text: b.text, at: Date.now() });
          } else if (b.type === "tool_use") {
            emit(jobId, {
              type: "tool",
              tool: b.name,
              input: b.input,
              at: Date.now(),
            });
          }
        }
        if (msg.error) {
          log(jobId, "error", `Assistant error: ${msg.error}`);
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success") {
          log(
            jobId,
            "info",
            `Agent finished in ${(msg.duration_ms / 1000).toFixed(1)}s (${msg.num_turns} turns, $${msg.total_cost_usd.toFixed(4)})`,
          );
        } else {
          log(jobId, "error", `Agent ended with error: ${JSON.stringify(msg)}`);
        }
      }
    }

    const out = outputPath(jobId);
    let outOk = false;
    try {
      await stat(out);
      outOk = true;
    } catch {
      outOk = false;
    }
    if (outOk) {
      setStatus(jobId, "completed");
      emit(jobId, { type: "done", outputPath: out, at: Date.now() });
    } else {
      setJobMeta(jobId, { error: "Agent finished without producing output/final.mp4" });
      setStatus(jobId, "failed");
      emit(jobId, { type: "done", outputPath: null, at: Date.now() });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(jobId, "error", `Agent crashed: ${msg}`);
    setJobMeta(jobId, { error: msg });
    setStatus(jobId, "failed");
    emit(jobId, { type: "done", outputPath: null, at: Date.now() });
  }
}
