import { spawn } from "node:child_process";

const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const YT_PATH_RE =
  /^\/(watch|shorts\/[\w-]+|embed\/[\w-]+|v\/[\w-]+)/;

/**
 * Normalize and validate a user-supplied URL. Returns the cleaned URL if it
 * targets a single YouTube video (regular or Short); throws otherwise. We are
 * deliberately strict to avoid using yt-dlp as an SSRF gadget.
 */
export function validateYouTubeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty URL");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("URL must be http(s)");
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(`Host ${host} is not a YouTube domain`);
  }
  if (host === "youtu.be") {
    if (!/^\/[\w-]{6,}/.test(parsed.pathname)) throw new Error("Bad youtu.be path");
  } else if (parsed.pathname === "/watch") {
    if (!parsed.searchParams.get("v")) throw new Error("Missing video id");
  } else if (!YT_PATH_RE.test(parsed.pathname)) {
    throw new Error("URL does not look like a single video / short");
  }
  return parsed.toString();
}

export type YtMeta = { title: string; durationSeconds: number; uploader: string | null };

/**
 * Download a single YouTube video (or Short) to the given output path. Quality is
 * capped at 720p to keep the download light. Returns basic metadata.
 */
export async function downloadYouTubeVideo(
  url: string,
  outputPath: string,
  opts: { onProgress?: (line: string) => void; timeoutMs?: number } = {},
): Promise<YtMeta> {
  const safeUrl = validateYouTubeUrl(url);
  const args = [
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--print",
    "after_move:%(title)s%(duration)s%(uploader)s",
    "-f",
    "bv*[height<=720]+ba/b[height<=720]/b",
    "--merge-output-format",
    "mp4",
    "--restrict-filenames",
    "-o",
    outputPath,
    safeUrl,
  ];

  return new Promise<YtMeta>((resolve, reject) => {
    const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      const s = b.toString();
      stdout += s;
      for (const line of s.split("\n")) if (line.trim()) opts.onProgress?.(line.trim());
    });
    child.stderr.on("data", (b) => {
      const s = b.toString();
      stderr += s;
      for (const line of s.split("\n")) if (line.trim()) opts.onProgress?.(line.trim());
    });
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`yt-dlp failed to spawn: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-400) || "(no stderr)"}`));
        return;
      }
      const lastLine = stdout
        .trim()
        .split("\n")
        .reverse()
        .find((l) => l.includes(""));
      if (!lastLine) {
        resolve({ title: "YouTube video", durationSeconds: 0, uploader: null });
        return;
      }
      const [title, duration, uploader] = lastLine.split("");
      resolve({
        title: title || "YouTube video",
        durationSeconds: Number(duration) || 0,
        uploader: uploader && uploader !== "NA" ? uploader : null,
      });
    });
  });
}
