import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { overlayY, renderOverlayPng, type TextOverlay } from "./text";

export class FfmpegError extends Error {
  constructor(message: string, public stderr: string, public code: number | null) {
    super(message);
    this.name = "FfmpegError";
  }
}

function runCapture(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new FfmpegError(`${cmd} timed out after ${opts.timeoutMs}ms`, stderr, null));
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(new FfmpegError(`${cmd} failed to spawn: ${err.message}`, stderr, null));
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${cmd} exited with code ${code}`, stderr, code));
    });
  });
}

export type ProbeResult = {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  bitrate: number | null;
};

export async function probe(path: string): Promise<ProbeResult> {
  await stat(path); // throws if missing
  const { stdout } = await runCapture(
    "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ],
    { timeoutMs: 30_000 },
  );
  const data = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string };
    streams?: Array<{
      codec_type: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
    }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new FfmpegError(`No video stream in ${path}`, "", null);
  const parseFps = (r?: string): number => {
    if (!r) return 0;
    const [n, d] = r.split("/").map(Number);
    if (!n || !d) return 0;
    return n / d;
  };
  return {
    path,
    duration: Number(data.format?.duration ?? 0),
    width: video.width ?? 0,
    height: video.height ?? 0,
    fps: parseFps(video.avg_frame_rate) || parseFps(video.r_frame_rate),
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name ?? "unknown",
    bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
  };
}

/** Returns timestamps (s) where scene-change score exceeds threshold (0-1). */
export async function detectScenes(
  path: string,
  threshold = 0.35,
  maxSamples = 60,
): Promise<number[]> {
  const { stderr } = await runCapture(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      path,
      "-filter:v",
      `select='gt(scene,${threshold})',showinfo`,
      "-f",
      "null",
      "-",
    ],
    { timeoutMs: 5 * 60_000 },
  );
  const times: number[] = [];
  const re = /pts_time:([0-9]+(?:\.[0-9]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    times.push(Number(m[1]));
    if (times.length >= maxSamples) break;
  }
  return times;
}

export async function trim(
  input: string,
  output: string,
  start: number,
  duration: number,
): Promise<void> {
  await runCapture(
    "ffmpeg",
    [
      "-hide_banner",
      "-y",
      "-ss",
      String(start),
      "-i",
      input,
      "-t",
      String(duration),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-avoid_negative_ts",
      "make_zero",
      output,
    ],
    { timeoutMs: 10 * 60_000 },
  );
}

/**
 * Transition between consecutive clips. `type` is an ffmpeg xfade transition name.
 * Audio is cross-faded with `acrossfade` over the same duration.
 */
export type Transition = {
  type:
    | "fade"
    | "fadeblack"
    | "fadewhite"
    | "wipeleft"
    | "wiperight"
    | "wipeup"
    | "wipedown"
    | "slideleft"
    | "slideright"
    | "dissolve"
    | "smoothleft"
    | "smoothright"
    | "circleopen"
    | "circleclose";
  duration_s: number;
};

/**
 * Concat clips by re-encoding with a uniform scale/pad to targetWidth x targetHeight.
 * When `transition` is provided, consecutive clips are joined with an xfade/acrossfade
 * pair instead of a hard cut.
 */
export async function concat(
  inputs: string[],
  output: string,
  targetWidth: number,
  targetHeight: number,
  targetFps = 30,
  transition?: Transition,
): Promise<void> {
  if (inputs.length === 0) throw new FfmpegError("concat: no inputs", "", null);
  const args: string[] = ["-hide_banner", "-y"];
  for (const i of inputs) args.push("-i", i);
  const filter: string[] = [];
  inputs.forEach((_, idx) => {
    filter.push(
      `[${idx}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=${targetFps},format=yuv420p[v${idx}]`,
    );
    filter.push(`[${idx}:a]aresample=async=1:first_pts=0[a${idx}]`);
  });

  if (transition && inputs.length > 1) {
    const durations = await Promise.all(inputs.map((i) => probe(i).then((p) => p.duration)));
    const T = Math.min(
      transition.duration_s,
      ...durations.map((d) => Math.max(0.1, d * 0.45)),
    );
    let prevV = "v0";
    let prevA = "a0";
    let running = durations[0];
    for (let i = 1; i < inputs.length; i++) {
      const last = i === inputs.length - 1;
      const outV = last ? "vout" : `vx${i}`;
      const outA = last ? "aout" : `ax${i}`;
      const offset = Math.max(0, running - T);
      filter.push(
        `[${prevV}][v${i}]xfade=transition=${transition.type}:duration=${T.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`,
      );
      filter.push(`[${prevA}][a${i}]acrossfade=d=${T.toFixed(3)}:c1=tri:c2=tri[${outA}]`);
      prevV = outV;
      prevA = outA;
      running = running + durations[i] - T;
    }
  } else {
    const vMap = inputs.map((_, i) => `[v${i}][a${i}]`).join("");
    filter.push(`${vMap}concat=n=${inputs.length}:v=1:a=1[vout][aout]`);
  }

  args.push(
    "-filter_complex",
    filter.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  );
  await runCapture("ffmpeg", args, { timeoutMs: 30 * 60_000 });
}

/**
 * Burn one or more text overlays into a clip. Each overlay is rendered as a
 * full-width transparent PNG and composited via ffmpeg's overlay filter,
 * timed by its start_s/duration_s.
 */
export async function addTextOverlays(
  input: string,
  output: string,
  overlays: TextOverlay[],
): Promise<void> {
  if (overlays.length === 0) {
    throw new FfmpegError("addTextOverlays: no overlays provided", "", null);
  }
  const meta = await probe(input);
  const W = meta.width;
  const H = meta.height;
  if (!W || !H) {
    throw new FfmpegError(`addTextOverlays: bad dimensions ${W}x${H} for ${input}`, "", null);
  }

  const work = await mkdtemp(path.join(tmpdir(), "ve-overlay-"));
  try {
    const args: string[] = ["-hide_banner", "-y", "-i", input];
    const filterParts: string[] = [];
    let prev = "0:v";
    for (let i = 0; i < overlays.length; i++) {
      const ov = overlays[i];
      const pngPath = path.join(work, `o${i}.png`);
      const { height: oh } = await renderOverlayPng(pngPath, W, H, ov);
      const y = overlayY(ov.position, H, oh);
      args.push("-i", pngPath);
      const out = i === overlays.length - 1 ? "vout" : `v${i}`;
      const end = ov.start_s + ov.duration_s;
      filterParts.push(
        `[${prev}][${i + 1}:v]overlay=x=0:y=${y}:enable='between(t,${ov.start_s.toFixed(3)},${end.toFixed(3)})'[${out}]`,
      );
      prev = out;
    }

    args.push(
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[vout]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      output,
    );

    await runCapture("ffmpeg", args, { timeoutMs: 10 * 60_000 });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * A simple effect applied to a whole clip. Used for span-scoped edits like
 * "speed this part up" or "make this section black and white".
 */
export type SpanEffect =
  | { name: "speed"; factor: number }
  | { name: "grayscale" }
  | { name: "blur"; strength?: number }
  | { name: "brightness"; value: number };

/** Chain `atempo` filters (each limited to 0.5–2.0) to reach an arbitrary factor. */
function atempoChain(factor: number): string {
  let f = factor;
  const parts: string[] = [];
  while (f > 2.0 + 1e-9) {
    parts.push("atempo=2.0");
    f /= 2;
  }
  while (f < 0.5 - 1e-9) {
    parts.push("atempo=0.5");
    f *= 2;
  }
  parts.push(`atempo=${f.toFixed(4)}`);
  return parts.join(",");
}

/**
 * Apply a single effect to `input`, writing a new clip to `output`. Audio is
 * copied through untouched except for `speed`, where it is retimed to match.
 */
export async function applyEffect(
  input: string,
  output: string,
  effect: SpanEffect,
): Promise<void> {
  const meta = await probe(input);
  const args: string[] = ["-hide_banner", "-y", "-i", input];
  let vf = "";
  let af: string | null = null;

  switch (effect.name) {
    case "speed": {
      const f = Math.min(4, Math.max(0.25, effect.factor));
      vf = `setpts=${(1 / f).toFixed(5)}*PTS`;
      af = meta.hasAudio ? atempoChain(f) : null;
      break;
    }
    case "grayscale":
      vf = "hue=s=0";
      break;
    case "blur": {
      const s = Math.min(50, Math.max(1, effect.strength ?? 10));
      vf = `boxblur=${s}:1`;
      break;
    }
    case "brightness": {
      const v = Math.min(1, Math.max(-1, effect.value));
      vf = `eq=brightness=${v.toFixed(3)}`;
      break;
    }
  }
  vf += ",format=yuv420p";

  args.push("-vf", vf);
  if (af) args.push("-af", af);
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
  );
  if (af) {
    args.push("-c:a", "aac", "-b:a", "128k");
  } else if (meta.hasAudio) {
    args.push("-c:a", "copy");
  }
  args.push("-movflags", "+faststart", output);

  await runCapture("ffmpeg", args, { timeoutMs: 10 * 60_000 });
}

export type BrollMode = "replace" | "pip";

/**
 * Overlay a b-roll clip onto a base (A-roll) clip as a cutaway. The base clip's
 * AUDIO always plays underneath — only the picture changes during the window.
 *   - "replace": b-roll fills the frame from `atS` for `durationS` (classic b-roll).
 *   - "pip": b-roll shows as a small picture-in-picture in the top-right corner.
 * The b-roll plays from its own start, time-shifted to begin at `atS`. Window
 * length is clamped to the b-roll's and base clip's durations.
 */
export async function insertBroll(
  base: string,
  broll: string,
  output: string,
  atS: number,
  durationS: number,
  mode: BrollMode = "replace",
): Promise<void> {
  const [b, r] = await Promise.all([probe(base), probe(broll)]);
  const W = b.width;
  const H = b.height;
  if (!W || !H) {
    throw new FfmpegError(`insertBroll: bad base dimensions ${W}x${H}`, "", null);
  }
  const fps = b.fps && b.fps > 0 ? Math.round(b.fps) : 30;
  const at = Math.max(0, Math.min(atS, Math.max(0, b.duration - 0.2)));
  const dur = Math.max(0.2, Math.min(durationS, r.duration, b.duration - at));
  const end = at + dur;
  const margin = Math.round(Math.min(W, H) * 0.04);

  const offsetPts = `setpts=PTS-STARTPTS+${at.toFixed(3)}/TB`;
  const enable = `enable='between(t,${at.toFixed(3)},${end.toFixed(3)})'`;
  let filter: string;
  if (mode === "pip") {
    filter =
      `[1:v]scale=${Math.round(W / 3)}:-2,setsar=1,fps=${fps},trim=0:${dur.toFixed(3)},${offsetPts}[bv];` +
      `[0:v][bv]overlay=x=W-w-${margin}:y=${margin}:${enable}:eof_action=pass,format=yuv420p[vout]`;
  } else {
    filter =
      `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=${fps},` +
      `trim=0:${dur.toFixed(3)},${offsetPts}[bv];` +
      `[0:v][bv]overlay=${enable}:eof_action=pass,format=yuv420p[vout]`;
  }

  const args = [
    "-hide_banner",
    "-y",
    "-i",
    base,
    "-i",
    broll,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ];
  await runCapture("ffmpeg", args, { timeoutMs: 10 * 60_000 });
}

/**
 * Composite a transparent overlay graphic (alpha .mov from Remotion, sized to the
 * base clip) on top of `base` during [atS, atS+durationS], keeping the base video
 * and audio underneath. The graphic animates from its own start at `atS`.
 */
export async function overlayGraphic(
  base: string,
  overlay: string,
  output: string,
  atS: number,
  durationS: number,
): Promise<void> {
  const b = await probe(base);
  const fps = b.fps && b.fps > 0 ? Math.round(b.fps) : 30;
  const at = Math.max(0, Math.min(atS, Math.max(0, b.duration - 0.2)));
  const dur = Math.max(0.2, Math.min(durationS, b.duration - at));
  const end = at + dur;

  const filter =
    `[1:v]fps=${fps},setpts=PTS-STARTPTS+${at.toFixed(3)}/TB[gv];` +
    `[0:v][gv]overlay=0:0:enable='between(t,${at.toFixed(3)},${end.toFixed(3)})':eof_action=pass:format=auto,` +
    `format=yuv420p[vout]`;

  const args = [
    "-hide_banner",
    "-y",
    "-i",
    base,
    "-i",
    overlay,
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ];
  await runCapture("ffmpeg", args, { timeoutMs: 10 * 60_000 });
}
