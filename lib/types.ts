export type JobStatus = "pending" | "running" | "completed" | "failed";

export type JobEvent =
  | { type: "log"; level: "info" | "warn" | "error"; message: string; at: number }
  | { type: "tool"; tool: string; input: unknown; at: number }
  | { type: "tool_result"; tool: string; ok: boolean; summary: string; at: number }
  | { type: "assistant"; text: string; at: number }
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
  error?: string;
  events: JobEvent[];
};
