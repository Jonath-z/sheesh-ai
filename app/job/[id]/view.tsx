"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { JobEvent, JobSummary } from "@/lib/types";

export default function JobView({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobSummary | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === "snapshot") {
          setJob(data.job as JobSummary);
          setEvents((data.job as JobSummary).events);
        } else {
          setEvents((prev) => [...prev, data as JobEvent]);
          if (data.type === "status") {
            setJob((prev) => (prev ? { ...prev, status: data.status } : prev));
          }
          if (data.type === "done") {
            setJob((prev) =>
              prev ? { ...prev, outputAvailable: data.outputPath !== null } : prev,
            );
            es.close();
          }
        }
      } catch (e) {
        setStreamError(String(e));
      }
    };
    es.onerror = () => {
      setStreamError("Connection to job stream lost");
      es.close();
    };
    return () => es.close();
  }, [jobId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events]);

  const status = job?.status ?? "pending";
  const outputReady = job?.outputAvailable ?? false;

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
        <header className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
              ← new job
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
              Editing job
            </h1>
            <p className="font-mono text-xs text-zinc-500">{jobId}</p>
          </div>
          <StatusBadge status={status} />
        </header>

        {outputReady && (
          <section className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Result</h2>
              <a
                href={`/api/jobs/${jobId}/output`}
                download="edit.mp4"
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Download
              </a>
            </div>
            <video
              key={jobId}
              controls
              src={`/api/jobs/${jobId}/output`}
              className="w-full rounded-md bg-black"
            />
          </section>
        )}

        <section className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Agent activity</h2>
            <span className="text-xs text-zinc-500">{events.length} events</span>
          </div>
          <div
            ref={logRef}
            className="flex max-h-[420px] flex-col gap-1 overflow-y-auto rounded-md bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          >
            {events.length === 0 && (
              <span className="text-zinc-500">Waiting for the agent to start…</span>
            )}
            {events.map((ev, i) => (
              <EventRow key={i} ev={ev} />
            ))}
          </div>
        </section>

        {job?.error && (
          <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {job.error}
          </p>
        )}
        {streamError && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            {streamError}
          </p>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status }: { status: JobSummary["status"] }) {
  const palette: Record<JobSummary["status"], string> = {
    pending: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    running: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
    completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  };
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-medium ${palette[status]}`}>
      {status}
    </span>
  );
}

function EventRow({ ev }: { ev: JobEvent }) {
  const ts = new Date(ev.at).toLocaleTimeString();
  if (ev.type === "log") {
    const color =
      ev.level === "error"
        ? "text-red-600 dark:text-red-400"
        : ev.level === "warn"
          ? "text-amber-600 dark:text-amber-400"
          : "text-zinc-600 dark:text-zinc-400";
    return (
      <div className={color}>
        <span className="opacity-60">{ts}</span> {ev.message}
      </div>
    );
  }
  if (ev.type === "assistant") {
    return (
      <div className="text-zinc-900 dark:text-zinc-100">
        <span className="opacity-60">{ts}</span> {ev.text}
      </div>
    );
  }
  if (ev.type === "tool") {
    return (
      <div className="text-violet-700 dark:text-violet-300">
        <span className="opacity-60">{ts}</span> → {ev.tool}
        <span className="opacity-60"> {summarizeInput(ev.input)}</span>
      </div>
    );
  }
  if (ev.type === "tool_result") {
    return (
      <div className={ev.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
        <span className="opacity-60">{ts}</span> ← {ev.tool} {ev.summary}
      </div>
    );
  }
  if (ev.type === "status") {
    return (
      <div className="text-blue-700 dark:text-blue-300">
        <span className="opacity-60">{ts}</span> status: {ev.status}
      </div>
    );
  }
  if (ev.type === "done") {
    return (
      <div className="text-zinc-900 dark:text-zinc-100">
        <span className="opacity-60">{ts}</span> done {ev.outputPath ? "✓" : "(no output)"}
      </div>
    );
  }
  return null;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return "";
  const parts: string[] = [];
  for (const k of keys.slice(0, 3)) {
    const v = obj[k];
    if (typeof v === "string") parts.push(`${k}=${shorten(v)}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
    else parts.push(`${k}=…`);
  }
  return `(${parts.join(", ")})`;
}

function shorten(s: string): string {
  if (s.length <= 28) return s;
  return s.slice(0, 12) + "…" + s.slice(-12);
}
