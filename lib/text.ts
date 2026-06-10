import { writeFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

export type TextPosition = "top" | "center" | "bottom";

export type TextOverlay = {
  text: string;
  position: TextPosition;
  start_s: number;
  duration_s: number;
  font_size?: number;
  color?: string;
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a single overlay as a PNG roughly the width of the canvas with a
 * transparent background. The text is white with a dark stroke so it reads
 * on any footage.
 */
export async function renderOverlayPng(
  out: string,
  canvasWidth: number,
  canvasHeight: number,
  overlay: TextOverlay,
): Promise<{ width: number; height: number }> {
  const fontSize = overlay.font_size ?? Math.round(canvasHeight * 0.07);
  const color = overlay.color ?? "#FFFFFF";
  const stroke = Math.max(2, Math.round(fontSize * 0.06));
  const margin = Math.round(fontSize * 0.5);
  const boxHeight = fontSize + margin * 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${boxHeight}" viewBox="0 0 ${canvasWidth} ${boxHeight}">
    <style>
      .t {
        font-family: -apple-system, system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif;
        font-weight: 700;
        font-size: ${fontSize}px;
        fill: ${color};
        stroke: rgba(0,0,0,0.85);
        stroke-width: ${stroke}px;
        paint-order: stroke fill;
      }
    </style>
    <text x="${canvasWidth / 2}" y="${boxHeight / 2}" text-anchor="middle" dominant-baseline="central" class="t">${escapeXml(overlay.text)}</text>
  </svg>`;

  const resvg = new Resvg(svg, {
    background: "rgba(0,0,0,0)",
    fitTo: { mode: "width", value: canvasWidth },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: "Helvetica Neue",
    },
  });
  const png = resvg.render();
  const buf = png.asPng();
  await writeFile(out, buf);
  return { width: png.width, height: png.height };
}

export function overlayY(
  position: TextPosition,
  canvasHeight: number,
  overlayHeight: number,
): number {
  const margin = Math.round(canvasHeight * 0.06);
  if (position === "top") return margin;
  if (position === "bottom") return canvasHeight - overlayHeight - margin;
  return Math.round((canvasHeight - overlayHeight) / 2);
}
