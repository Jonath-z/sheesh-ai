import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ClipProvenance,
  ClipSource,
  JobEvent,
  JobStatus,
  JobSummary,
  VideoTimeline,
} from "./types";

/** Filename stem (basename without extension), used as the provenance key. */
export function stemOf(p: string): string {
  return path.basename(p).replace(/\.[^.]+$/, "");
}

/** Walk the provenance chain back to the source footage + cut range. */
export function resolveClipSource(
  stem: string,
  prov: Record<string, ClipProvenance>,
): ClipSource | undefined {
  const ops: string[] = [];
  let cur = stem;
  for (let i = 0; i < 24; i++) {
    const p = prov[cur];
    if (!p) return undefined;
    if (p.kind === "trim") {
      const footage = path.basename(p.source).replace(/^\d+_/, "");
      return { from: "footage", footage, inS: p.startS, outS: p.startS + p.durationS, ops };
    }
    if (p.kind === "title") return { from: "generated", label: "Title card", ops };
    if (p.kind === "span") return { from: "generated", label: "Edited span", ops };
    ops.unshift(p.op);
    cur = p.from;
  }
  return undefined;
}

const WORKSPACE_ROOT = path.join(process.cwd(), "workspaces");

type Subscriber = (event: JobEvent) => void;

type JobState = {
  summary: JobSummary;
  subscribers: Set<Subscriber>;
  abort: AbortController;
};

const jobs = new Map<string, JobState>();

export function workspaceDirs(jobId: string) {
  const root = path.join(WORKSPACE_ROOT, jobId);
  return {
    root,
    raw: path.join(root, "raw"),
    reference: path.join(root, "reference"),
    broll: path.join(root, "broll"),
    clips: path.join(root, "clips"),
    output: path.join(root, "output"),
  };
}

function jobFile(jobId: string): string {
  return path.join(workspaceDirs(jobId).root, "job.json");
}

// Coalesce rapid writes to job.json: while a write is in flight, mark the job
// dirty and re-flush once when it lands, so we never lose the latest state and
// never interleave concurrent writers on the same file.
const persistState = new Map<string, { writing: boolean; dirty: boolean }>();

function persist(jobId: string): void {
  const s = persistState.get(jobId) ?? { writing: false, dirty: false };
  persistState.set(jobId, s);
  if (s.writing) {
    s.dirty = true;
    return;
  }
  s.writing = true;
  void (async () => {
    do {
      s.dirty = false;
      const job = jobs.get(jobId);
      if (!job) break;
      try {
        await writeFile(jobFile(jobId), JSON.stringify(job.summary));
      } catch {
        // best-effort persistence
      }
    } while (s.dirty);
    s.writing = false;
  })();
}

export async function createJob(): Promise<string> {
  const id = randomUUID();
  const dirs = workspaceDirs(id);
  await Promise.all([
    mkdir(dirs.raw, { recursive: true }),
    mkdir(dirs.reference, { recursive: true }),
    mkdir(dirs.broll, { recursive: true }),
    mkdir(dirs.clips, { recursive: true }),
    mkdir(dirs.output, { recursive: true }),
  ]);
  jobs.set(id, {
    summary: {
      id,
      status: "pending",
      createdAt: Date.now(),
      footageCount: 0,
      hasReference: false,
      outputAvailable: false,
      events: [],
    },
    subscribers: new Set(),
    abort: new AbortController(),
  });
  persist(id);
  return id;
}

/**
 * Return a job from memory, hydrating it from job.json on disk if the process
 * was restarted. A job that was mid-run when the process died can no longer be
 * streaming, so a stale "running" status is reconciled on load.
 */
export async function loadJob(id: string): Promise<JobSummary | null> {
  const existing = jobs.get(id);
  if (existing) return existing.summary;
  let summary: JobSummary;
  try {
    summary = JSON.parse(await readFile(jobFile(id), "utf8")) as JobSummary;
  } catch {
    return null;
  }
  if (summary.status === "running") {
    summary.status = summary.outputAvailable ? "completed" : "failed";
    if (!summary.outputAvailable && !summary.error) {
      summary.error = "Interrupted by a server restart";
    }
  }
  jobs.set(id, { summary, subscribers: new Set(), abort: new AbortController() });
  return summary;
}

export function setSessionId(id: string, sessionId: string): void {
  const j = jobs.get(id);
  if (!j) return;
  j.summary.sessionId = sessionId;
  persist(id);
}

export function getSessionId(id: string): string | null {
  return jobs.get(id)?.summary.sessionId ?? null;
}

export function setTimeline(id: string, timeline: VideoTimeline): void {
  const j = jobs.get(id);
  if (!j) return;
  j.summary.timeline = timeline;
  // emit() persists and notifies subscribers (live timeline update).
  emit(id, { type: "timeline", timeline, at: Date.now() });
}

/** Record how a produced clip was made, so the timeline can show cut provenance. */
export function recordClipSource(id: string, stem: string, prov: ClipProvenance): void {
  const j = jobs.get(id);
  if (!j) return;
  if (!j.summary.provenance) j.summary.provenance = {};
  j.summary.provenance[stem] = prov;
  // Announce the clip live so the UI can show the agent cutting in real time.
  // emit() persists, so no separate persist() call is needed.
  emit(id, {
    type: "clip_ready",
    clip: { name: stem, source: resolveClipSource(stem, j.summary.provenance) },
    at: Date.now(),
  });
}

export function getProvenance(id: string): Record<string, ClipProvenance> {
  return jobs.get(id)?.summary.provenance ?? {};
}

export function getJob(id: string): JobSummary | null {
  return jobs.get(id)?.summary ?? null;
}

export function getAbortSignal(id: string): AbortSignal | null {
  return jobs.get(id)?.abort.signal ?? null;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.abort.abort();
  return true;
}

export function setJobMeta(
  id: string,
  patch: Partial<Pick<JobSummary, "footageCount" | "hasReference" | "outputAvailable" | "error">>,
): void {
  const j = jobs.get(id);
  if (!j) return;
  Object.assign(j.summary, patch);
  persist(id);
}

export function emit(id: string, event: JobEvent): void {
  const j = jobs.get(id);
  if (!j) return;
  j.summary.events.push(event);
  if (event.type === "status") {
    j.summary.status = event.status;
    if (event.status === "running" && !j.summary.startedAt) j.summary.startedAt = event.at;
    if (event.status === "completed" || event.status === "failed") j.summary.finishedAt = event.at;
  }
  if (event.type === "done") {
    j.summary.outputAvailable = event.outputPath !== null;
  }
  for (const sub of j.subscribers) {
    try {
      sub(event);
    } catch {
      // ignore subscriber failures
    }
  }
  persist(id);
}

export function setStatus(id: string, status: JobStatus): void {
  emit(id, { type: "status", status, at: Date.now() });
}

export function log(id: string, level: "info" | "warn" | "error", message: string): void {
  emit(id, { type: "log", level, message, at: Date.now() });
}

export function subscribe(id: string, sub: Subscriber): () => void {
  const j = jobs.get(id);
  if (!j) return () => {};
  j.subscribers.add(sub);
  return () => {
    j.subscribers.delete(sub);
  };
}

export async function listFootage(id: string): Promise<string[]> {
  const dirs = workspaceDirs(id);
  const names = await readdir(dirs.raw);
  return names
    .filter((n) => !n.startsWith("."))
    .sort()
    .map((n) => path.join(dirs.raw, n));
}

export async function listBroll(id: string): Promise<string[]> {
  const dirs = workspaceDirs(id);
  try {
    const names = await readdir(dirs.broll);
    return names
      .filter((n) => !n.startsWith("."))
      .sort()
      .map((n) => path.join(dirs.broll, n));
  } catch {
    return [];
  }
}

export async function getReference(id: string): Promise<string | null> {
  const dirs = workspaceDirs(id);
  const names = await readdir(dirs.reference);
  const first = names.find((n) => !n.startsWith("."));
  return first ? path.join(dirs.reference, first) : null;
}

export function outputPath(id: string): string {
  return path.join(workspaceDirs(id).output, "final.mp4");
}

export function referenceUrlFile(id: string): string {
  return path.join(workspaceDirs(id).reference, ".url");
}
