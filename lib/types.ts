export type JobStatus = "pending" | "running" | "completed" | "failed";

/** A selected span of a video, in seconds. */
export type VideoRange = { startS: number; endS: number };

/**
 * How a produced clip was made, keyed by filename stem. `trim` is the base case
 * (a cut from raw footage); `derive` points at the clip it was built from.
 */
export type ClipProvenance =
  | { kind: "trim"; source: string; startS: number; durationS: number }
  | { kind: "derive"; from: string; op: string }
  | { kind: "title" }
  | { kind: "span" };

/** Resolved origin of a timeline clip, for display. */
export type ClipSource =
  | { from: "footage"; footage: string; inS: number; outS: number; ops: string[] }
  | { from: "generated"; label: string; ops: string[] };

/** One clip in the assembled timeline, positioned within the final video. */
export type TimelineClip = {
  name: string;
  startS: number;
  durationS: number;
  /** Where this clip came from (source footage + cut range, or generated). */
  source?: ClipSource;
};

/** Structured view of the current assembled edit, used to render the timeline. */
export type VideoTimeline = {
  clips: TimelineClip[];
  totalS: number;
  width: number;
  height: number;
  transition: { type: string; durationS: number } | null;
};

export type JobEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: number }
  | { type: "tool"; tool: string; input: unknown; at: number }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string; at: number }
  | { type: "assistant"; text: string; at: number }
  | { type: "user_message"; text: string; range?: VideoRange; at: number }
  | { type: "timeline"; timeline: VideoTimeline; at: number }
  | { type: "clip_ready"; clip: { name: string; source?: ClipSource }; at: number }
  | { type: "status"; status: JobStatus; at: number }
  | { type: "done"; outputPath: string | null; at: number };

export type JobSummary = {
  id: string;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  footageCount: number;
  hasReference: boolean;
  outputAvailable: boolean;
  /** Resumable Claude Agent SDK session id; set once the first turn completes. */
  sessionId?: string;
  /** Structured timeline of the current edit; set after each assemble. */
  timeline?: VideoTimeline;
  /** Cut provenance for produced clips, keyed by filename stem. */
  provenance?: Record<string, ClipProvenance>;
  error?: string;
  events: JobEvent[];
};
