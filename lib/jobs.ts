import { mkdir, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { JobEvent, JobStatus, JobSummary } from "./types";

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
    clips: path.join(root, "clips"),
    output: path.join(root, "output"),
  };
}

export async function createJob(): Promise<string> {
  const id = randomUUID();
  const dirs = workspaceDirs(id);
  await Promise.all([
    mkdir(dirs.raw, { recursive: true }),
    mkdir(dirs.reference, { recursive: true }),
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
  return id;
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
