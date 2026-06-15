import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const graphicSchema = z.object({
  kind: z.enum(["lower_third", "callout"]),
  title: z.string().min(1).max(120),
  subtitle: z.string().max(120).default(""),
  theme: z.enum(["minimal", "bold", "cinematic"]),
  position: z.enum(["top", "center", "bottom"]),
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  duration_s: z.number().min(0.5).max(30),
  fps: z.number().int().min(15).max(60),
});

type Props = z.infer<typeof graphicSchema>;

const SANS =
  '-apple-system, "Helvetica Neue", Helvetica, "Segoe UI", Roboto, Arial, sans-serif';

const THEMES: Record<Props["theme"], { bg: string; text: string; accent: string }> = {
  minimal: { bg: "rgba(10,10,10,0.82)", text: "#ffffff", accent: "#9aa0a6" },
  bold: { bg: "rgba(255,0,110,0.92)", text: "#ffffff", accent: "#ffd60a" },
  cinematic: { bg: "rgba(13,27,42,0.86)", text: "#f1e9d2", accent: "#e0b86b" },
};

/**
 * A transparent overlay graphic, rendered with an alpha channel and composited
 * over footage by ffmpeg. Two kinds: an animated lower-third (slides in from the
 * left) and a callout pill (pops in, centered).
 */
export const Graphic: React.FC<Props> = ({
  kind,
  title,
  subtitle,
  theme,
  position,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const t = THEMES[theme];

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 110, mass: 0.6 },
  });
  const exit = interpolate(
    frame,
    [durationInFrames - Math.round(fps * 0.4), durationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const opacity = Math.min(enter, exit);

  const padV = Math.round(height * 0.06);
  const padH = Math.round(width * 0.05);
  const justifyContent =
    position === "top" ? "flex-start" : position === "center" ? "center" : "flex-end";

  if (kind === "callout") {
    const fontSize = Math.round(height * 0.042);
    return (
      <AbsoluteFill
        style={{
          justifyContent,
          alignItems: "center",
          padding: `${padV}px ${padH}px`,
          backgroundColor: "transparent",
          fontFamily: SANS,
        }}
      >
        <div
          style={{
            transform: `scale(${0.6 + 0.4 * enter})`,
            opacity,
            display: "flex",
            alignItems: "center",
            gap: Math.round(fontSize * 0.5),
            background: t.bg,
            color: t.text,
            padding: `${Math.round(fontSize * 0.5)}px ${Math.round(fontSize * 1.1)}px`,
            borderRadius: 999,
            fontSize,
            fontWeight: 700,
            maxWidth: "82%",
            textAlign: "center",
            boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
          }}
        >
          <span
            style={{
              width: Math.round(fontSize * 0.4),
              height: Math.round(fontSize * 0.4),
              borderRadius: 999,
              background: t.accent,
              flexShrink: 0,
            }}
          />
          {title}
        </div>
      </AbsoluteFill>
    );
  }

  // lower_third
  const titleSize = Math.round(height * 0.05);
  const subSize = Math.round(height * 0.026);
  return (
    <AbsoluteFill
      style={{
        justifyContent,
        alignItems: "flex-start",
        padding: `${padV}px ${padH}px`,
        backgroundColor: "transparent",
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          transform: `translateX(${(1 - enter) * -40}px)`,
          opacity,
          display: "flex",
          alignItems: "stretch",
          gap: Math.round(titleSize * 0.4),
          background: t.bg,
          padding: `${Math.round(titleSize * 0.5)}px ${Math.round(titleSize * 0.8)}px`,
          borderRadius: Math.round(titleSize * 0.25),
          maxWidth: "75%",
          boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            width: Math.max(3, Math.round(titleSize * 0.12)),
            background: t.accent,
            borderRadius: 99,
            flexShrink: 0,
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: titleSize, fontWeight: 700, color: t.text, lineHeight: 1.1 }}>
            {title}
          </div>
          {subtitle && subtitle.length > 0 ? (
            <div
              style={{
                fontSize: subSize,
                color: t.accent,
                marginTop: Math.round(subSize * 0.3),
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};
