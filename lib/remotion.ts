import path from "node:path";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";

export type TitleCardKind = "intro" | "outro";
export type TitleCardTheme = "minimal" | "bold" | "cinematic";

export type TitleCardProps = {
  text: string;
  subtitle?: string;
  theme: TitleCardTheme;
  kind: TitleCardKind;
  width: number;
  height: number;
  duration_s: number;
  fps?: number;
};

const REMOTION_ENTRY = path.join(process.cwd(), "remotion", "index.ts");

let bundlePromise: Promise<string> | null = null;
let browserPromise: Promise<unknown> | null = null;

function getBundle(onProgress?: (msg: string) => void): Promise<string> {
  if (bundlePromise) return bundlePromise;
  onProgress?.("Bundling Remotion compositions…");
  const p = bundle({ entryPoint: REMOTION_ENTRY }).catch((e) => {
    bundlePromise = null;
    throw e;
  });
  bundlePromise = p;
  return p;
}

function getBrowser(onProgress?: (msg: string) => void): Promise<unknown> {
  if (browserPromise) return browserPromise;
  onProgress?.("Ensuring headless browser (may download Chromium on first run)…");
  const p = ensureBrowser().catch((e) => {
    browserPromise = null;
    throw e;
  });
  browserPromise = p;
  return p;
}

export async function renderTitleCard(
  output: string,
  props: TitleCardProps,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const fps = props.fps ?? 30;
  const inputProps = {
    text: props.text,
    subtitle: props.subtitle ?? "",
    theme: props.theme,
    kind: props.kind,
    width: props.width,
    height: props.height,
    duration_s: props.duration_s,
    fps,
  };

  const [serveUrl] = await Promise.all([
    getBundle(onProgress),
    getBrowser(onProgress),
  ]);

  const composition = await selectComposition({
    serveUrl,
    id: "TitleCard",
    inputProps,
  });

  onProgress?.(
    `Rendering ${props.kind} card "${props.text}" at ${composition.width}x${composition.height}, ${(composition.durationInFrames / composition.fps).toFixed(2)}s`,
  );

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: output,
    inputProps,
    audioCodec: "aac",
    enforceAudioTrack: true,
    pixelFormat: "yuv420p",
    x264Preset: "veryfast",
    crf: 20,
  });
}
