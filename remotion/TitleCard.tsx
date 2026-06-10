import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

export const titleCardSchema = z.object({
  text: z.string().min(1).max(120),
  subtitle: z.string().max(120).default(""),
  theme: z.enum(["minimal", "bold", "cinematic"]),
  kind: z.enum(["intro", "outro"]),
  width: z.number().int().min(64).max(7680),
  height: z.number().int().min(64).max(4320),
  duration_s: z.number().min(0.5).max(15),
  fps: z.number().int().min(15).max(60),
});

type Props = z.infer<typeof titleCardSchema>;

type Theme = {
  bgStart: string;
  bgEnd: string;
  text: string;
  accent: string;
  weight: number;
  letterSpacing: string;
  uppercase: boolean;
};

const THEMES: Record<Props["theme"], Theme> = {
  minimal: {
    bgStart: "#0a0a0a",
    bgEnd: "#1f1f1f",
    text: "#ffffff",
    accent: "#9aa0a6",
    weight: 600,
    letterSpacing: "-0.025em",
    uppercase: false,
  },
  bold: {
    bgStart: "#ff006e",
    bgEnd: "#3a86ff",
    text: "#ffffff",
    accent: "#ffd60a",
    weight: 900,
    letterSpacing: "-0.04em",
    uppercase: true,
  },
  cinematic: {
    bgStart: "#0d1b2a",
    bgEnd: "#1b263b",
    text: "#f1e9d2",
    accent: "#e0b86b",
    weight: 500,
    letterSpacing: "0.06em",
    uppercase: true,
  },
};

export const TitleCard: React.FC<Props> = ({
  text,
  subtitle,
  theme,
  kind,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps, width, height } = useVideoConfig();
  const t = THEMES[theme];

  // For outros, run the same animation but reversed in time so the card
  // dissolves out as the video ends.
  const animFrame = kind === "intro" ? frame : durationInFrames - 1 - frame;

  const titleSpring = spring({
    frame: animFrame,
    fps,
    config: { damping: 14, stiffness: 95, mass: 0.7 },
  });
  const subtitleSpring = spring({
    frame: animFrame - Math.round(fps * 0.18),
    fps,
    config: { damping: 18, stiffness: 90 },
  });

  // Subtle scale-back after the spring-in to add breathing
  const hold = interpolate(
    animFrame,
    [Math.round(fps * 0.6), durationInFrames - Math.round(fps * 0.4)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const titleScale = titleSpring * (1 - 0.04 * hold);

  // Background gradient slowly rotates and shifts during the card
  const bgAngle = interpolate(frame, [0, durationInFrames], [35, 75]);
  const bgShift = interpolate(frame, [0, durationInFrames], [0, 20]);

  // Animated accent bar grows in under the title
  const barProgress = interpolate(
    animFrame,
    [Math.round(fps * 0.25), Math.round(fps * 0.85)],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // For intro/outro card fade at the very edges
  const edgeFade = Math.min(
    interpolate(frame, [0, Math.round(fps * 0.25)], [0, 1], {
      extrapolateRight: "clamp",
    }),
    interpolate(
      frame,
      [durationInFrames - Math.round(fps * 0.35), durationInFrames - 1],
      [1, 0],
      { extrapolateLeft: "clamp" },
    ),
  );

  const titleFontSize = Math.round(height * 0.12);
  const subtitleFontSize = Math.round(height * 0.028);
  const barWidth = width * 0.18;
  const barHeight = Math.max(2, Math.round(height * 0.005));

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${bgAngle}deg, ${t.bgStart} ${bgShift}%, ${t.bgEnd} ${80 + bgShift}%)`,
        opacity: edgeFade,
      }}
    >
      {/* soft vignette */}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.45) 100%)",
        }}
      />

      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          flexDirection: "column",
          padding: "0 8%",
          textAlign: "center",
          fontFamily:
            '-apple-system, "Helvetica Neue", Helvetica, "Segoe UI", Roboto, Arial, sans-serif',
        }}
      >
        <div
          style={{
            fontWeight: t.weight,
            fontSize: titleFontSize,
            color: t.text,
            letterSpacing: t.letterSpacing,
            textTransform: t.uppercase ? "uppercase" : "none",
            transform: `translateY(${(1 - titleSpring) * height * 0.05}px) scale(${titleScale})`,
            opacity: titleSpring,
            lineHeight: 1.05,
          }}
        >
          {text}
        </div>

        <div
          style={{
            marginTop: Math.round(height * 0.035),
            width: barWidth,
            height: barHeight,
            background: t.accent,
            transform: `scaleX(${barProgress})`,
            transformOrigin: "left center",
            borderRadius: barHeight,
          }}
        />

        {subtitle && subtitle.length > 0 && (
          <div
            style={{
              marginTop: Math.round(height * 0.032),
              fontSize: subtitleFontSize,
              color: t.accent,
              opacity: subtitleSpring,
              transform: `translateY(${(1 - subtitleSpring) * 20}px)`,
              letterSpacing: "0.28em",
              textTransform: "uppercase",
              fontWeight: 500,
            }}
          >
            {subtitle}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
