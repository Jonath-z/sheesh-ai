import path from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z } from "zod";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import {
  addTextOverlays,
  applyEffect,
  concat,
  detectScenes,
  insertBroll,
  overlayGraphic,
  probe,
  trim,
  type ProbeResult,
  type SpanEffect,
  type Transition,
} from "./ffmpeg";
import { renderGraphicOverlay, renderTitleCard } from "./remotion";
import {
  emit,
  getJob,
  getProvenance,
  getReference,
  getSessionId,
  listBroll,
  listFootage,
  log,
  outputPath,
  recordClipSource,
  referenceUrlFile,
  resolveClipSource,
  setJobMeta,
  setSessionId,
  setStatus,
  setTimeline,
  stemOf,
  workspaceDirs,
} from "./jobs";
import { downloadYouTubeVideo } from "./youtube";
import { readFile } from "node:fs/promises";
import type { VideoRange, VideoTimeline } from "./types";

const SERVER_NAME = "editor";

/** Probe each ordered clip, resolve its origin, and build the timeline model. */
async function buildTimeline(
  jobId: string,
  clipPaths: string[],
  width: number,
  height: number,
  transition: VideoTimeline["transition"],
): Promise<VideoTimeline> {
  const durations = await Promise.all(
    clipPaths.map((c) => probe(c).then((p) => p.duration).catch(() => 0)),
  );
  const prov = getProvenance(jobId);
  let acc = 0;
  const clips = clipPaths.map((c, i) => {
    const stem = stemOf(c);
    const item = {
      name: stem,
      startS: acc,
      durationS: durations[i],
      source: resolveClipSource(stem, prov),
    };
    acc += durations[i];
    return item;
  });
  return { clips, totalS: acc, width, height, transition };
}

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

  const list_broll = tool(
    "list_broll",
    "List the b-roll clips uploaded for this job — supplementary cutaway footage to overlay on top of the main (A-roll) clips. Returns absolute file paths; empty if none were uploaded.",
    {},
    async () => {
      try {
        const items = await listBroll(jobId);
        emit(jobId, {
          type: "tool_result",
          tool: "list_broll",
          ok: true,
          summary: items.length ? `${items.length} b-roll clips` : "no b-roll",
          at: Date.now(),
        });
        return ok({ broll: items });
      } catch (e) {
        return err(String(e));
      }
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
        recordClipSource(jobId, name, {
          kind: "trim",
          source: abs,
          startS: start_s,
          durationS: duration_s,
        });
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
        recordClipSource(jobId, name, { kind: "derive", from: stemOf(source), op: "caption" });
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
        recordClipSource(jobId, name, { kind: "title" });
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

        // Capture a structured timeline so the UI can render real clip cards.
        setTimeline(
          jobId,
          await buildTimeline(
            jobId,
            clips,
            target_width,
            target_height,
            transition ? { type: transition.type, durationS: transition.duration_s } : null,
          ),
        );

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

  const add_graphic = tool(
    "add_graphic",
    "Overlay an ANIMATED motion-graphic on a clip with transparency. kind 'lower_third' = a name/label bar that slides in from the left (title + optional subtitle; great for introducing a person or place). kind 'callout' = a pill badge that pops in, centered (short highlight/label). Unlike add_text_overlay (static burned text), this is animated. position sets vertical placement; theme matches mood. Returns a new clip path; use it IN PLACE OF the source in assemble_edit. at_s/duration_s are relative to the clip's own timeline.",
    {
      source: z.string().describe("Absolute path to a clip in this job's workspace"),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Output filename stem, e.g. 'clip_02_l3'"),
      kind: z.enum(["lower_third", "callout"]),
      title: z.string().min(1).max(80),
      subtitle: z
        .string()
        .max(80)
        .optional()
        .describe("Lower-third only; small line under the title"),
      theme: z.enum(["minimal", "bold", "cinematic"]),
      position: z.enum(["top", "center", "bottom"]).default("bottom"),
      at_s: z.number().min(0).default(0),
      duration_s: z.number().min(0.5).max(20).default(3),
    },
    async ({ source, name, kind, title, subtitle, theme, position, at_s, duration_s }) => {
      try {
        const baseAbs = withinWorkspace(jobId, source);
        const meta = await probe(baseAbs);
        const out = path.join(dirs.clips, `${name}.mp4`);
        emit(jobId, {
          type: "tool",
          tool: "add_graphic",
          input: { source, name, kind, title, position, at_s, duration_s },
          at: Date.now(),
        });
        const work = await mkdtemp(path.join(tmpdir(), "ve-gfx-"));
        try {
          const mov = path.join(work, "overlay.mov");
          await renderGraphicOverlay(
            mov,
            {
              kind,
              title,
              subtitle,
              theme,
              position,
              width: meta.width,
              height: meta.height,
              duration_s,
              fps: meta.fps && meta.fps > 0 ? Math.round(meta.fps) : 30,
            },
            (m) => log(jobId, "info", m),
          );
          await overlayGraphic(baseAbs, mov, out, at_s, duration_s);
        } finally {
          await rm(work, { recursive: true, force: true });
        }
        await stat(out);
        recordClipSource(jobId, name, { kind: "derive", from: stemOf(source), op: kind });
        emit(jobId, {
          type: "tool_result",
          tool: "add_graphic",
          ok: true,
          summary: `${name}.mp4 (${kind} "${title}", ${duration_s}s @ ${at_s}s)`,
          at: Date.now(),
        });
        return ok({ path: out });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const insert_broll = tool(
    "insert_broll",
    "Overlay a b-roll clip onto a base (A-roll) clip as a cutaway. The base clip's AUDIO keeps playing underneath the whole time — only the picture changes during the window. mode 'replace' shows the b-roll full-frame from at_s for duration_s (classic b-roll); mode 'pip' shows it small in the top-right corner. Returns a new clip path; use it in assemble_edit IN PLACE OF the base clip. at_s/duration_s are relative to the base clip's own timeline.",
    {
      base: z.string().describe("Absolute path to the A-roll clip to cut away from"),
      broll: z.string().describe("Absolute path to a b-roll clip (from list_broll)"),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Output filename stem, e.g. 'clip_03_broll'"),
      at_s: z.number().min(0).describe("When the cutaway starts within the base clip"),
      duration_s: z.number().min(0.3).max(30),
      mode: z.enum(["replace", "pip"]).default("replace"),
    },
    async ({ base, broll, name, at_s, duration_s, mode }) => {
      try {
        const baseAbs = withinWorkspace(jobId, base);
        const brollAbs = withinWorkspace(jobId, broll);
        const out = path.join(dirs.clips, `${name}.mp4`);
        emit(jobId, {
          type: "tool",
          tool: "insert_broll",
          input: { base, broll, name, at_s, duration_s, mode },
          at: Date.now(),
        });
        await insertBroll(baseAbs, brollAbs, out, at_s, duration_s, mode);
        await stat(out);
        recordClipSource(jobId, name, { kind: "derive", from: stemOf(base), op: "b-roll" });
        emit(jobId, {
          type: "tool_result",
          tool: "insert_broll",
          ok: true,
          summary: `${name}.mp4 (${mode} b-roll ${duration_s.toFixed(1)}s @ ${at_s.toFixed(1)}s)`,
          at: Date.now(),
        });
        return ok({ path: out });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const split_output_span = tool(
    "split_output_span",
    "Split the current edited video (output/final.mp4) at a time span into up to three clips: the part BEFORE the span, the span ITSELF, and the part AFTER. Use this to edit just a portion the user selected on the player. Then: process the returned `span` clip (apply_effect, add_text_overlay, trim, or drop it entirely to delete that section), and finally call assemble_edit with [before, <your edited span>, after] (skip any that are null) to rebuild the video. Times are seconds within the current edit.",
    {
      start_s: z.number().min(0),
      end_s: z.number().min(0.1),
      prefix: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .default("span")
        .describe("Filename stem for the produced clips"),
    },
    async ({ start_s, end_s, prefix }) => {
      try {
        const out = outputPath(jobId);
        emit(jobId, {
          type: "tool",
          tool: "split_output_span",
          input: { start_s, end_s, prefix },
          at: Date.now(),
        });
        const meta = await probe(out);
        const dur = meta.duration;
        const start = Math.max(0, Math.min(start_s, dur));
        const end = Math.max(start + 0.1, Math.min(end_s, dur));
        const before = start > 0.05 ? path.join(dirs.clips, `${prefix}_before.mp4`) : null;
        const span = path.join(dirs.clips, `${prefix}_mid.mp4`);
        const after = end < dur - 0.05 ? path.join(dirs.clips, `${prefix}_after.mp4`) : null;
        if (before) await trim(out, before, 0, start);
        await trim(out, span, start, end - start);
        if (after) await trim(out, after, end, dur - end);
        if (before) recordClipSource(jobId, `${prefix}_before`, { kind: "span" });
        recordClipSource(jobId, `${prefix}_mid`, { kind: "span" });
        if (after) recordClipSource(jobId, `${prefix}_after`, { kind: "span" });
        emit(jobId, {
          type: "tool_result",
          tool: "split_output_span",
          ok: true,
          summary: `span ${start.toFixed(1)}-${end.toFixed(1)}s of ${dur.toFixed(1)}s edit → ${[before && "before", "span", after && "after"].filter(Boolean).join(", ")}`,
          at: Date.now(),
        });
        return ok({ before, span, after, duration_s: dur });
      } catch (e) {
        return err(String(e));
      }
    },
  );

  const apply_effect = tool(
    "apply_effect",
    "Apply a visual/temporal effect to a clip and write a new clip. Effects: speed (factor 0.25-4; <1 slow-motion, >1 faster — audio is retimed to match), grayscale (black & white), blur (strength 1-50), brightness (-1 darker … +1 brighter). Returns the new clip path; use it in assemble_edit in place of the source. Great for span edits: split_output_span, then apply_effect on the returned span.",
    {
      source: z.string().describe("Absolute path to a clip in this job's workspace"),
      name: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe("Output filename stem, e.g. 'span_mid_fast'"),
      effect: z.discriminatedUnion("name", [
        z.object({ name: z.literal("speed"), factor: z.number().min(0.25).max(4) }),
        z.object({ name: z.literal("grayscale") }),
        z.object({
          name: z.literal("blur"),
          strength: z.number().min(1).max(50).default(10),
        }),
        z.object({ name: z.literal("brightness"), value: z.number().min(-1).max(1) }),
      ]),
    },
    async ({ source, name, effect }) => {
      try {
        const abs = withinWorkspace(jobId, source);
        const outClip = path.join(dirs.clips, `${name}.mp4`);
        emit(jobId, {
          type: "tool",
          tool: "apply_effect",
          input: { source, name, effect: effect.name },
          at: Date.now(),
        });
        await applyEffect(abs, outClip, effect as SpanEffect);
        await stat(outClip);
        recordClipSource(jobId, name, { kind: "derive", from: stemOf(source), op: effect.name });
        emit(jobId, {
          type: "tool_result",
          tool: "apply_effect",
          ok: true,
          summary: `${name}.mp4 (${effect.name})`,
          at: Date.now(),
        });
        return ok({ path: outClip });
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
      list_broll,
      probe_clip,
      detect_scenes_tool,
      trim_clip,
      add_text_overlay,
      render_title_card,
      add_graphic,
      insert_broll,
      split_output_span,
      apply_effect,
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
   c. ANIMATED overlay graphic ON TOP of a footage clip via add_graphic — a lower_third (name/label bar that slides in) or a callout (pill badge that pops in). Use this instead of (a) when you want motion: introduce a speaker/place with a lower_third, or pop a short highlight with a callout. Returns a new clip path; use IT (not the original) in assemble_edit.
   - You can mix these (e.g. a bold intro card + an animated lower-third on the first talking clip). Skip titles entirely if nothing meaningful to add.
7.5. B-ROLL (optional). Call list_broll. If b-roll clips exist, they are supplementary cutaway footage meant to play OVER your main clips. For a clip whose audio is worth keeping (someone talking, narration, ambient sound) but whose picture is static or dull, call insert_broll(base=<that clip>, broll=<a b-roll clip>, at_s, duration_s, mode="replace") to cut away to b-roll while the base audio continues. Use it on 1-3 clips at most — b-roll should accent, not dominate. Use the returned clip IN PLACE OF the base clip in assemble_edit. Skip entirely if there is no b-roll or nothing benefits from a cutaway.
8. Choose an ordering that feels good (chronological per source, or grouped by visual energy; you decide). If you rendered an intro card, it goes first; outro goes last.
9. Call assemble_edit ONCE with the ordered clip paths and target resolution. Pick a transition:
   - Energetic / many scene changes → omit transition (hard cuts) or use a short fade (0.25s).
   - Contemplative / few scene changes → use "fade" or "dissolve" at 0.5-0.8s.
   - For a bold opener, "fadeblack" works well.
   - When unsure, default to fade at 0.4s. Include a one-sentence note describing your edit decisions.
10. After assemble_edit succeeds, reply with a single sentence summarizing the result and stop. Do not call any more tools.

FOLLOW-UP REQUESTS (interactive mode):
After the first edit is delivered, the user may keep chatting to revise it — e.g. "make the intro shorter", "add a caption at 0:12", "use a punchier transition", "swap clips 2 and 3". This conversation is resumed, so you still have all your earlier context and the trimmed clips in clips/ still exist. For each follow-up:
 - Make the SMALLEST change that satisfies the request; don't redo the whole edit.
 - Reuse existing clips where possible; only re-trim or re-render what must change.
 - SPAN EDITS: when the user selected a time range of the current cut (you'll be told the start/end seconds, or they reference a timestamp), use split_output_span(start_s, end_s) to cut output/final.mp4 into before / span / after. Then transform just the span — apply_effect (speed/grayscale/blur/brightness), add_text_overlay (caption), trim it shorter, or omit it entirely to delete that section — and call assemble_edit with [before, <edited span>, after] (skip nulls) to rebuild. This guarantees you only touch the selected region.
 - Call assemble_edit again to refresh output/final.mp4, preserving everything the user didn't ask to change.
 - Then reply with one sentence describing what changed, and stop.

Use the note tool sparingly to explain non-obvious choices. Be decisive — don't ask for clarification, and don't loop forever. If a tool errors, log it via note and try once more with adjusted inputs, then move on.`;

const EDITOR_TOOLS = [
  "list_footage",
  "get_reference",
  "list_broll",
  "probe_clip",
  "detect_scenes",
  "trim_clip",
  "add_text_overlay",
  "render_title_card",
  "add_graphic",
  "insert_broll",
  "split_output_span",
  "apply_effect",
  "assemble_edit",
  "note",
].map((n) => `mcp__${SERVER_NAME}__${n}`);

/**
 * Run a single agent turn against the job's workspace. Used both for the first
 * autonomous edit and for each follow-up chat message (via `resume`). Streams
 * assistant/tool events as they arrive and returns the session id so the next
 * turn can resume the conversation.
 */
async function runAgentTurn(
  jobId: string,
  opts: { prompt: string; resume?: string },
): Promise<{ sessionId: string | null; ok: boolean }> {
  const mcp = buildEditorServer(jobId);
  const dirs = workspaceDirs(jobId);
  let sessionId: string | null = null;
  let ok = false;

  const q = query({
    prompt: opts.prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [SERVER_NAME]: mcp },
      tools: [],
      allowedTools: EDITOR_TOOLS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      cwd: dirs.root,
      ...(opts.resume ? { resume: opts.resume } : {}),
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
          emit(jobId, { type: "tool", tool: b.name, input: b.input, at: Date.now() });
        }
      }
      if (msg.error) {
        log(jobId, "error", `Assistant error: ${msg.error}`);
      }
    } else if (msg.type === "result") {
      sessionId = msg.session_id ?? sessionId;
      if (msg.subtype === "success") {
        ok = true;
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

  return { sessionId, ok };
}

/**
 * Reconcile job status against what's on disk after a turn ends. The first turn
 * must produce output/final.mp4 or it failed; follow-up turns may legitimately
 * not touch the output (e.g. answering a question), so a missing output is only
 * fatal when `requireOutput` is set.
 */
async function finalizeTurn(jobId: string, requireOutput: boolean): Promise<void> {
  const out = outputPath(jobId);
  let outOk = false;
  try {
    await stat(out);
    outOk = true;
  } catch {
    outOk = false;
  }
  setJobMeta(jobId, { outputAvailable: outOk });
  if (!outOk && requireOutput) {
    setJobMeta(jobId, { error: "Agent finished without producing output/final.mp4" });
    setStatus(jobId, "failed");
    emit(jobId, { type: "done", outputPath: null, at: Date.now() });
    return;
  }
  setStatus(jobId, "completed");
  emit(jobId, { type: "done", outputPath: outOk ? out : null, at: Date.now() });
}

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

  const broll = await listBroll(jobId);
  const dirs = workspaceDirs(jobId);
  const userPrompt = [
    `Job workspace: ${dirs.root}`,
    `Footage count: ${footage.length}`,
    `Reference video: ${ref ? "yes" : "no"}`,
    `B-roll clips: ${broll.length > 0 ? `${broll.length} (consider cutaways)` : "none"}`,
    "",
    "Begin the edit now. Follow the workflow exactly.",
  ].join("\n");

  try {
    const { sessionId } = await runAgentTurn(jobId, { prompt: userPrompt });
    if (sessionId) setSessionId(jobId, sessionId);
    await finalizeTurn(jobId, true);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(jobId, "error", `Agent crashed: ${msg}`);
    setJobMeta(jobId, { error: msg });
    setStatus(jobId, "failed");
    emit(jobId, { type: "done", outputPath: null, at: Date.now() });
  }
}

function buildFollowupPrompt(text: string, range?: VideoRange): string {
  const lines: string[] = [];
  if (range) {
    lines.push(
      `The user selected the span ${range.startS.toFixed(2)}s–${range.endS.toFixed(2)}s of the current edit (output/final.mp4) and wants the change applied to that span.`,
    );
  }
  lines.push(`User request: ${text}`);
  lines.push("");
  lines.push(
    "Apply this to the existing edit, reusing clips where possible, then call assemble_edit to refresh output/final.mp4. Preserve everything the user didn't ask to change. Reply with one sentence describing what changed, then stop.",
  );
  return lines.join("\n");
}

/**
 * Continue an existing edit from a chat message. Resumes the agent's session so
 * it keeps all prior context, applies the requested change, and refreshes the
 * output. Streams events into the same job channel as the initial run.
 */
export async function sendAgentMessage(
  jobId: string,
  text: string,
  range?: VideoRange,
): Promise<void> {
  const sessionId = getSessionId(jobId);
  if (!sessionId) {
    throw new Error("This job has no resumable session yet — wait for the first edit to finish.");
  }

  emit(jobId, { type: "user_message", text, range, at: Date.now() });
  setJobMeta(jobId, { error: undefined });
  setStatus(jobId, "running");

  try {
    const { sessionId: newId } = await runAgentTurn(jobId, {
      prompt: buildFollowupPrompt(text, range),
      resume: sessionId,
    });
    if (newId) setSessionId(jobId, newId);
    await finalizeTurn(jobId, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(jobId, "error", `Agent crashed: ${msg}`);
    setJobMeta(jobId, { error: msg });
    setStatus(jobId, "failed");
    emit(jobId, { type: "done", outputPath: null, at: Date.now() });
  }
}

/**
 * Deterministic manual re-trim of a single timeline clip (no LLM). Re-cuts the
 * clip from its source footage with new in/out points, then re-assembles the
 * final video using the existing clip order. Only works on plain trimmed clips;
 * clips with effects/graphics must be adjusted via the Assistant.
 */
export async function manualRetrim(
  jobId: string,
  clipName: string,
  inS: number,
  outS: number,
): Promise<void> {
  const job = getJob(jobId);
  if (!job?.timeline) throw new Error("No timeline to edit yet.");
  const prov = getProvenance(jobId)[clipName];
  if (!prov || prov.kind !== "trim") {
    throw new Error("This clip has effects or is generated — adjust it via the Assistant.");
  }

  const timeline = job.timeline;
  setJobMeta(jobId, { error: undefined });
  setStatus(jobId, "running");
  try {
    const src = await probe(prov.source);
    const max = src.duration;
    const ni = Math.max(0, Math.min(inS, max - 0.2));
    const no = Math.max(ni + 0.2, Math.min(outS, max));
    log(
      jobId,
      "info",
      `Manual trim: ${clipName} ← ${path.basename(prov.source)} [${ni.toFixed(2)}–${no.toFixed(2)}]`,
    );

    const dirs = workspaceDirs(jobId);
    const clipPath = path.join(dirs.clips, `${clipName}.mp4`);
    await trim(prov.source, clipPath, ni, no - ni);
    recordClipSource(jobId, clipName, {
      kind: "trim",
      source: prov.source,
      startS: ni,
      durationS: no - ni,
    });

    const order = timeline.clips.map((c) => path.join(dirs.clips, `${c.name}.mp4`));
    const transition = timeline.transition
      ? { type: timeline.transition.type as Transition["type"], duration_s: timeline.transition.durationS }
      : undefined;
    const out = outputPath(jobId);
    await concat(order, out, timeline.width, timeline.height, 30, transition);
    setTimeline(
      jobId,
      await buildTimeline(jobId, order, timeline.width, timeline.height, timeline.transition),
    );
    setJobMeta(jobId, { outputAvailable: true });
    setStatus(jobId, "completed");
    emit(jobId, { type: "done", outputPath: out, at: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(jobId, "error", `Manual trim failed: ${msg}`);
    setJobMeta(jobId, { error: msg });
    setStatus(jobId, "completed");
    emit(jobId, { type: "done", outputPath: outputPath(jobId), at: Date.now() });
  }
}
