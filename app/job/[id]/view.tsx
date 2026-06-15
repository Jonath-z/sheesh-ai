"use client";

import Link from "next/link";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  ClipSource,
  JobEvent,
  JobSummary,
  TimelineClip,
  VideoRange,
  VideoTimeline,
} from "@/lib/types";

type PoolClip = { name: string; source?: ClipSource };

type Sel = { startS: number | null; endS: number | null };

export default function JobView({ jobId }: { jobId: string }) {
  const [job, setJob] = useState<JobSummary | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [outputVersion, setOutputVersion] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Sel>({ startS: null, endS: null });
  const [chatOpen, setChatOpen] = useState(false);
  const [gridOn, setGridOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

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
          if (data.type === "timeline") {
            setJob((prev) => (prev ? { ...prev, timeline: data.timeline } : prev));
          }
          if (data.type === "done") {
            setJob((prev) =>
              prev ? { ...prev, outputAvailable: data.outputPath !== null } : prev,
            );
            if (data.outputPath !== null) {
              setOutputVersion((v) => v + 1);
              setSel({ startS: null, endS: null });
            }
          }
          if (data.type === "user_message") {
            setJob((prev) =>
              prev ? { ...prev, sessionId: prev.sessionId ?? "live" } : prev,
            );
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

  const status = job?.status ?? "pending";
  const outputReady = job?.outputAvailable ?? false;
  const canChat = Boolean(job?.sessionId) || outputReady;
  const working = status === "running";
  const timeline = job?.timeline ?? null;
  const total = duration > 0 ? duration : timeline?.totalS ?? 0;
  const range: VideoRange | null =
    sel.startS != null && sel.endS != null && sel.endS > sel.startS
      ? { startS: sel.startS, endS: sel.endS }
      : null;

  // Every clip the agent has produced, in production order — drives the live
  // "agent's clips" strip. Derived from the event stream so it survives reloads.
  const pool = useMemo<PoolClip[]>(() => {
    const m = new Map<string, ClipSource | undefined>();
    for (const e of events) if (e.type === "clip_ready") m.set(e.clip.name, e.clip.source);
    return Array.from(m, ([name, source]) => ({ name, source }));
  }, [events]);

  async function retrim(clipName: string, inS: number, outS: number) {
    try {
      await fetch(`/api/jobs/${jobId}/retrim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clipName, inS, outS }),
      });
      // Result (new cut + timeline) arrives over SSE.
    } catch {
      // surfaced via the job error banner if it fails server-side
    }
  }

  function seek(t: number) {
    const v = videoRef.current;
    const clamped = Math.max(0, total > 0 ? Math.min(t, total) : t);
    if (v) v.currentTime = clamped;
    setCurrentTime(clamped);
  }
  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }

  return (
    <div className="relative flex h-[100dvh] flex-col overflow-hidden bg-[#0b0b0d] text-zinc-200">
      <TopBar
        jobId={jobId}
        status={status}
        outputReady={outputReady}
        outputVersion={outputVersion}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((o) => !o)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Stage
            jobId={jobId}
            videoRef={videoRef}
            outputReady={outputReady}
            outputVersion={outputVersion}
            currentTime={currentTime}
            gridOn={gridOn}
            status={status}
            events={events}
            onLoadedMetadata={(d) => setDuration(d)}
            onTimeUpdate={(t) => setCurrentTime(t)}
            onPlayingChange={setPlaying}
          />

          {outputReady && (
            <Transport
              playing={playing}
              currentTime={currentTime}
              total={total}
              gridOn={gridOn}
              onToggleGrid={() => setGridOn((g) => !g)}
              onTogglePlay={togglePlay}
              onSeek={seek}
              onFullscreen={() => videoRef.current?.requestFullscreen?.()}
            />
          )}

          <Timeline
            timeline={timeline}
            total={total}
            currentTime={currentTime}
            sel={sel}
            setSel={setSel}
            onSeek={seek}
            onRetrim={retrim}
            working={working}
            pool={pool}
          />
        </div>

        {chatOpen && (
          <ChatDrawer
            jobId={jobId}
            events={events}
            canChat={canChat}
            working={working}
            range={range}
            onConsumeRange={() => setSel({ startS: null, endS: null })}
            onClose={() => setChatOpen(false)}
          />
        )}
      </div>

      {(job?.error || streamError) && (
        <div className="pointer-events-none absolute bottom-4 left-4 z-20 max-w-md">
          {job?.error && (
            <p className="mb-2 rounded-md border border-red-900 bg-red-950/80 px-3 py-2 text-xs text-red-300 backdrop-blur">
              {job.error}
            </p>
          )}
          {streamError && (
            <p className="rounded-md border border-amber-900 bg-amber-950/80 px-3 py-2 text-xs text-amber-300 backdrop-blur">
              {streamError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Top bar */

function TopBar({
  jobId,
  status,
  outputReady,
  outputVersion,
  chatOpen,
  onToggleChat,
}: {
  jobId: string;
  status: JobSummary["status"];
  outputReady: boolean;
  outputVersion: number;
  chatOpen: boolean;
  onToggleChat: () => void;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-[#111114] px-3">
      <Link
        href="/"
        className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        aria-label="Home"
      >
        <Icon name="home" />
      </Link>

      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">Drafts</span>
        <span className="text-zinc-700">/</span>
        <div className="flex items-center gap-2 rounded-md bg-zinc-800/70 px-3 py-1.5 text-sm text-zinc-100">
          <span className="font-medium">Video Edit</span>
          <span className="font-mono text-[10px] text-zinc-500">
            {jobId.slice(0, 8)}
          </span>
        </div>
      </div>

      <Link
        href="/"
        className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      >
        <Icon name="plus" className="h-3.5 w-3.5" /> Create New Project
      </Link>

      <div className="ml-auto flex items-center gap-1.5">
        <StatusDot status={status} />
        <button
          onClick={onToggleChat}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
            chatOpen
              ? "bg-[#f0584d] text-white"
              : "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          }`}
        >
          <Icon name="chat" className="h-3.5 w-3.5" /> Assistant
        </button>
        {outputReady && (
          <a
            href={`/api/jobs/${jobId}/output?v=${outputVersion}`}
            download="edit.mp4"
            className="flex items-center gap-1.5 rounded-md bg-zinc-800 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-700"
          >
            <Icon name="download" className="h-3.5 w-3.5" /> Export
          </a>
        )}
      </div>
    </header>
  );
}

function StatusDot({ status }: { status: JobSummary["status"] }) {
  const map: Record<JobSummary["status"], { c: string; label: string }> = {
    pending: { c: "bg-zinc-500", label: "pending" },
    running: { c: "bg-blue-400 animate-pulse", label: "editing" },
    completed: { c: "bg-emerald-400", label: "ready" },
    failed: { c: "bg-red-400", label: "failed" },
  };
  const s = map[status];
  return (
    <span className="mr-1 flex items-center gap-1.5 text-[11px] text-zinc-400">
      <span className={`h-1.5 w-1.5 rounded-full ${s.c}`} /> {s.label}
    </span>
  );
}

/* ----------------------------------------------------------------- Stage */

function Stage({
  jobId,
  videoRef,
  outputReady,
  outputVersion,
  currentTime,
  gridOn,
  status,
  events,
  onLoadedMetadata,
  onTimeUpdate,
  onPlayingChange,
}: {
  jobId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  outputReady: boolean;
  outputVersion: number;
  currentTime: number;
  gridOn: boolean;
  status: JobSummary["status"];
  events: JobEvent[];
  onLoadedMetadata: (d: number) => void;
  onTimeUpdate: (t: number) => void;
  onPlayingChange: (p: boolean) => void;
}) {
  const lastActivity = [...events]
    .reverse()
    .map((e) =>
      e.type === "assistant"
        ? e.text
        : e.type === "log"
          ? e.message
          : e.type === "tool_result"
            ? `${e.tool}: ${e.summary}`
            : null,
    )
    .find((x): x is string => Boolean(x));

  return (
    <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#0b0b0d] p-6">
      {outputReady ? (
        <div className="relative max-h-full max-w-full">
          <video
            key={`${jobId}-${outputVersion}`}
            ref={videoRef}
            src={`/api/jobs/${jobId}/output?v=${outputVersion}`}
            onLoadedMetadata={(e) => onLoadedMetadata(e.currentTarget.duration || 0)}
            onTimeUpdate={(e) => onTimeUpdate(e.currentTarget.currentTime)}
            onPlay={() => onPlayingChange(true)}
            onPause={() => onPlayingChange(false)}
            className="max-h-[62vh] rounded-md bg-black shadow-2xl shadow-black/60"
          />
          {gridOn && <RuleOfThirds />}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-2 py-0.5 font-mono text-[11px] text-zinc-200">
            {fmtTime(currentTime)}
          </div>
        </div>
      ) : (
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-[#f0584d]" />
          <p className="text-sm text-zinc-300">
            {status === "failed"
              ? "The edit didn't finish."
              : "Rendering your first cut…"}
          </p>
          {lastActivity && (
            <p className="line-clamp-2 text-xs text-zinc-500">{lastActivity}</p>
          )}
        </div>
      )}
    </div>
  );
}

function RuleOfThirds() {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 grid grid-cols-3 grid-rows-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="border border-amber-200/30" />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Transport */

function Transport({
  playing,
  currentTime,
  total,
  gridOn,
  onToggleGrid,
  onTogglePlay,
  onSeek,
  onFullscreen,
}: {
  playing: boolean;
  currentTime: number;
  total: number;
  gridOn: boolean;
  onToggleGrid: () => void;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onFullscreen: () => void;
}) {
  const ctl =
    "flex h-8 w-8 items-center justify-center rounded-md text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100";
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-t border-zinc-800 bg-[#111114] px-3">
      <button onClick={onToggleGrid} className={`${ctl} ${gridOn ? "text-[#cdf25e]" : ""}`} title="Rule-of-thirds grid">
        <Icon name="grid" />
      </button>

      <div className="mx-auto flex items-center gap-1">
        <button onClick={() => onSeek(0)} className={ctl} title="To start">
          <Icon name="toStart" />
        </button>
        <button onClick={() => onSeek(currentTime - 1)} className={ctl} title="Back 1s">
          <Icon name="rewind" />
        </button>
        <button
          onClick={onTogglePlay}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f0584d] text-white hover:bg-[#e14a40]"
          title={playing ? "Pause" : "Play"}
        >
          <Icon name={playing ? "pause" : "play"} className="h-4 w-4" />
        </button>
        <button onClick={() => onSeek(currentTime + 1)} className={ctl} title="Forward 1s">
          <Icon name="ffwd" />
        </button>
        <button onClick={() => onSeek(total)} className={ctl} title="To end">
          <Icon name="toEnd" />
        </button>
      </div>

      <span className="font-mono text-xs text-zinc-400">
        {fmtTime(currentTime)} <span className="text-zinc-600">/ {fmtTime(total)}</span>
      </span>
      <button onClick={onFullscreen} className={ctl} title="Fullscreen">
        <Icon name="fullscreen" />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- Timeline */

const CLIP_GRADIENTS = [
  "linear-gradient(135deg,#3b2f5e,#5b3b8c)",
  "linear-gradient(135deg,#1f4d4a,#2f7d6b)",
  "linear-gradient(135deg,#5e3b2f,#8c5a3b)",
  "linear-gradient(135deg,#2f3b5e,#3b5a8c)",
  "linear-gradient(135deg,#5e2f4a,#8c3b6b)",
  "linear-gradient(135deg,#4a4a2f,#7d7d3b)",
];

function Timeline({
  timeline,
  total,
  currentTime,
  sel,
  setSel,
  onSeek,
  onRetrim,
  working,
  pool,
}: {
  timeline: VideoTimeline | null;
  total: number;
  currentTime: number;
  sel: Sel;
  setSel: (s: Sel) => void;
  onSeek: (t: number) => void;
  onRetrim: (clipName: string, inS: number, outS: number) => void;
  working: boolean;
  pool: PoolClip[];
}) {
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  // Live preview of a clip being trimmed via its handles (in/out in source time).
  const [draft, setDraft] = useState<{ name: string; inS: number; outS: number } | null>(null);
  const trimRef = useRef<{
    name: string;
    edge: "in" | "out";
    startX: number;
    inS: number;
    outS: number;
  } | null>(null);

  const pct = (t: number) =>
    total > 0 ? `${Math.max(0, Math.min(100, (t / total) * 100))}%` : "0%";

  function timeFromClientX(clientX: number): number {
    const el = laneRef.current;
    if (!el || total <= 0) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((clientX - r.left) / r.width) * total));
  }

  function onTrimMove(e: ReactPointerEvent) {
    const d = trimRef.current;
    const el = laneRef.current;
    if (!d || !el || total <= 0) return;
    const dt = ((e.clientX - d.startX) / el.getBoundingClientRect().width) * total;
    let inS = d.inS;
    let outS = d.outS;
    if (d.edge === "out") outS = Math.max(inS + 0.2, d.outS + dt);
    else inS = Math.max(0, Math.min(d.inS + dt, d.outS - 0.2));
    setDraft({ name: d.name, inS, outS });
  }

  function onTrimUp(e: ReactPointerEvent) {
    const d = trimRef.current;
    trimRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d && draft && draft.name === d.name) {
      const changed = Math.abs(draft.inS - d.inS) > 0.05 || Math.abs(draft.outS - d.outS) > 0.05;
      if (changed) onRetrim(d.name, draft.inS, draft.outS);
    }
    setDraft(null);
  }

  function startTrim(e: ReactPointerEvent, c: TimelineClip, edge: "in" | "out") {
    e.stopPropagation();
    const s = c.source;
    if (!s || s.from !== "footage") return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    trimRef.current = { name: c.name, edge, startX: e.clientX, inS: s.inS, outS: s.outS };
    setDraft({ name: c.name, inS: s.inS, outS: s.outS });
  }

  const hasStart = sel.startS != null;
  const hasEnd = sel.endS != null;
  const validSel = hasStart && hasEnd && (sel.endS as number) > (sel.startS as number);
  const activeIdx =
    timeline?.clips.findIndex(
      (c) => currentTime >= c.startS && currentTime < c.startS + c.durationS,
    ) ?? -1;

  const ticks = total > 0 ? buildTicks(total) : [];

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-zinc-800 bg-[#0e0e11] px-3 pb-3 pt-2">
      {/* selection controls */}
      <div className="flex items-center gap-2 text-[11px] text-zinc-400">
        <span className="font-medium uppercase tracking-wider text-zinc-500">Timeline</span>
        {total > 0 && (
          <>
            <button
              onClick={() => setSel({ ...sel, startS: currentTime })}
              className="rounded bg-zinc-800 px-2 py-0.5 hover:bg-zinc-700"
            >
              Mark in ⟦
            </button>
            <button
              onClick={() => setSel({ ...sel, endS: currentTime })}
              className="rounded bg-zinc-800 px-2 py-0.5 hover:bg-zinc-700"
            >
              Mark out ⟧
            </button>
            {(hasStart || hasEnd) && (
              <button
                onClick={() => setSel({ startS: null, endS: null })}
                className="text-zinc-500 hover:text-zinc-300"
              >
                clear
              </button>
            )}
            {validSel && (
              <span className="rounded-full bg-[#cdf25e]/15 px-2 py-0.5 font-mono text-[#cdf25e]">
                {fmtTime(sel.startS as number)}–{fmtTime(sel.endS as number)} → open Assistant to edit it
              </span>
            )}
          </>
        )}
      </div>

      {/* live "agent's clips" strip — clips appear here as they get cut */}
      {pool.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-600">
            Agent&apos;s clips ({pool.length})
          </span>
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {pool.map((c) => {
              const s = c.source;
              return (
                <div
                  key={c.name}
                  className="ve-pop flex shrink-0 flex-col rounded bg-zinc-800/80 px-2 py-1"
                  title={c.name}
                >
                  <span className="max-w-[120px] truncate text-[10px] text-zinc-200">
                    {s ? (s.from === "footage" ? s.footage : s.label) : c.name}
                  </span>
                  <span className="font-mono text-[9px] text-[#cdf25e]">
                    {s && s.from === "footage"
                      ? `${fmtTime(s.inS)}–${fmtTime(s.outS)}`
                      : s && s.ops.length > 0
                        ? s.ops.join("+")
                        : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ruler */}
      <div className="relative h-4 select-none">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute top-0 -translate-x-1/2 font-mono text-[9px] text-zinc-600"
            style={{ left: pct(t) }}
          >
            {fmtTime(t)}
          </span>
        ))}
      </div>

      {/* scrubbable lane */}
      <div
        ref={laneRef}
        onPointerDown={(e) => {
          if (total <= 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
          onSeek(timeFromClientX(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging) onSeek(timeFromClientX(e.clientX));
        }}
        onPointerUp={(e) => {
          setDragging(false);
          e.currentTarget.releasePointerCapture?.(e.pointerId);
        }}
        className="relative h-16 cursor-pointer rounded-md bg-zinc-900/60"
      >
        {/* clip cards */}
        {timeline?.clips.map((c, i) => {
          const src = c.source;
          const dft = draft && draft.name === c.name ? draft : null;
          const isDraft = dft != null;
          const durS = dft ? dft.outS - dft.inS : c.durationS;
          const w = total > 0 ? (durS / total) * 100 : 0;
          const trimmable = src?.from === "footage" && src.ops.length === 0;
          const topLabel = src
            ? src.from === "footage"
              ? src.footage
              : src.label
            : c.name;
          const inS = dft ? dft.inS : src?.from === "footage" ? src.inS : null;
          const outS = dft ? dft.outS : src?.from === "footage" ? src.outS : null;
          const cut = inS != null && outS != null ? `${fmtTime(inS)}–${fmtTime(outS)}` : null;
          return (
            <div
              key={c.name}
              className={`ve-pop absolute top-1 bottom-1 overflow-hidden rounded-md border ${
                i === activeIdx ? "border-[#cdf25e]" : "border-black/40"
              } ${isDraft ? "" : "transition-[left,width] duration-300 ease-out"}`}
              style={{
                left: pct(c.startS),
                width: `${w}%`,
                backgroundImage: CLIP_GRADIENTS[i % CLIP_GRADIENTS.length],
              }}
              title={clipTooltip(c)}
            >
              <div className="absolute inset-x-0 top-0 truncate bg-black/40 px-1.5 py-0.5 text-[9px] font-medium text-zinc-100">
                {topLabel}
              </div>
              {cut && (
                <div className="absolute inset-x-0 bottom-0 truncate bg-black/40 px-1.5 py-px font-mono text-[8px] text-[#cdf25e]">
                  {cut}
                </div>
              )}
              {trimmable && (
                <>
                  <div
                    onPointerDown={(e) => startTrim(e, c, "in")}
                    onPointerMove={onTrimMove}
                    onPointerUp={onTrimUp}
                    className="absolute left-0 top-0 bottom-0 z-20 w-2 cursor-ew-resize bg-[#cdf25e]/30 hover:bg-[#cdf25e]/80"
                    title="Drag to trim the start (extend earlier / start later)"
                  />
                  <div
                    onPointerDown={(e) => startTrim(e, c, "out")}
                    onPointerMove={onTrimMove}
                    onPointerUp={onTrimUp}
                    className="absolute right-0 top-0 bottom-0 z-20 w-2 cursor-ew-resize bg-[#cdf25e]/30 hover:bg-[#cdf25e]/80"
                    title="Drag to trim the end (extend longer / cut shorter)"
                  />
                </>
              )}
            </div>
          );
        })}

        {/* placeholder when no timeline yet */}
        {(!timeline || timeline.clips.length === 0) && (
          <div className="flex h-full items-center justify-center text-xs text-zinc-600">
            {working ? "Assembling clips…" : "No clips yet"}
          </div>
        )}

        {/* selection band */}
        {validSel && total > 0 && (
          <div
            className="absolute top-0 bottom-0 border-x border-[#cdf25e] bg-[#cdf25e]/15"
            style={{
              left: pct(sel.startS as number),
              width: `calc(${pct(sel.endS as number)} - ${pct(sel.startS as number)})`,
            }}
          />
        )}

        {/* playhead */}
        {total > 0 && (
          <div
            className="pointer-events-none absolute -top-1 bottom-0 z-10 w-0.5 bg-[#cdf25e]"
            style={{ left: pct(currentTime) }}
          >
            <span className="absolute -top-[18px] left-1/2 -translate-x-1/2 rounded bg-[#cdf25e] px-1 py-px font-mono text-[9px] font-semibold text-black">
              {fmtTime(currentTime)}
            </span>
          </div>
        )}
      </div>

      {/* active clip provenance — which footage is playing and where it was cut */}
      {activeIdx >= 0 && timeline?.clips[activeIdx] && (
        <ClipReadout clip={timeline.clips[activeIdx]} index={activeIdx} />
      )}

      {/* mixed-audio lane (visual representation of the final mix) */}
      <div className="relative h-7 rounded-md bg-zinc-900/40">
        <div className="flex h-full items-center gap-1.5 px-2 text-[10px] text-zinc-600">
          <Icon name="audio" className="h-3 w-3" />
          <span>Audio (mixed)</span>
        </div>
        {total > 0 && (
          <div
            className="pointer-events-none absolute -top-0 bottom-0 z-10 w-0.5 bg-[#cdf25e]/50"
            style={{ left: pct(currentTime) }}
          />
        )}
      </div>
    </div>
  );
}

function ClipReadout({ clip, index }: { clip: TimelineClip; index: number }) {
  const s = clip.source;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
      <span className="text-zinc-500">Clip {index + 1}:</span>
      <span className="text-zinc-200">{clip.name}</span>
      {s?.from === "footage" ? (
        <>
          <span className="text-zinc-600">from</span>
          <span className="text-zinc-300">{s.footage}</span>
          <span className="font-mono text-[#cdf25e]">
            {fmtTime(s.inS)}–{fmtTime(s.outS)}
          </span>
          <span className="text-zinc-600">(source in/out)</span>
        </>
      ) : s ? (
        <span className="text-zinc-300">{s.label}</span>
      ) : (
        <span className="text-zinc-600">source unknown</span>
      )}
      {s?.ops && s.ops.length > 0 && (
        <span className="text-zinc-500">· {s.ops.join(" → ")}</span>
      )}
    </div>
  );
}

function clipTooltip(c: TimelineClip): string {
  const parts: string[] = [c.name, `${c.durationS.toFixed(1)}s`];
  const s = c.source;
  if (s?.from === "footage")
    parts.push(`from ${s.footage} [${fmtTime(s.inS)}–${fmtTime(s.outS)}]`);
  else if (s) parts.push(s.label);
  if (s?.ops?.length) parts.push(`ops: ${s.ops.join(", ")}`);
  return parts.join(" • ");
}

function buildTicks(total: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => total / s <= 10) ?? 600;
  const out: number[] = [];
  for (let t = 0; t <= total + 0.001; t += step) out.push(Math.round(t));
  return out;
}

/* ----------------------------------------------------------- Chat drawer */

function ChatDrawer({
  jobId,
  events,
  canChat,
  working,
  range,
  onConsumeRange,
  onClose,
}: {
  jobId: string;
  events: JobEvent[];
  canChat: boolean;
  working: boolean;
  range: VideoRange | null;
  onConsumeRange: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"chat" | "activity">("chat");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const messages = events.filter(
    (e): e is Extract<JobEvent, { type: "user_message" | "assistant" }> =>
      e.type === "user_message" || e.type === "assistant",
  );

  useEffect(() => {
    if (tab === "chat" && threadRef.current)
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    if (tab === "activity" && logRef.current)
      logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages.length, events.length, working, tab]);

  async function send() {
    const text = input.trim();
    if (!text || sending || working) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(range ? { text, range } : { text }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setInput("");
      onConsumeRange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  const disabled = !canChat || working || sending;

  return (
    <aside className="flex min-h-0 w-[360px] shrink-0 flex-col border-l border-zinc-800 bg-[#111114]">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-800 px-2">
        <TabButton active={tab === "chat"} onClick={() => setTab("chat")}>
          Assistant
        </TabButton>
        <TabButton active={tab === "activity"} onClick={() => setTab("activity")}>
          Activity
        </TabButton>
        <button
          onClick={onClose}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          aria-label="Close"
        >
          <Icon name="close" />
        </button>
      </div>

      {tab === "chat" ? (
        <>
          <div ref={threadRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <p className="text-xs text-zinc-500">
                {canChat
                  ? "Ask for changes — e.g. “punchier transitions”, “add a lower-third on clip 2”, or mark a span on the timeline and describe an edit for it."
                  : "The assistant unlocks once the first cut is ready."}
              </p>
            )}
            {messages.map((m, i) => (
              <ChatBubble key={i} message={m} />
            ))}
            {working && (
              <div className="self-start rounded-2xl rounded-bl-sm bg-zinc-800 px-3 py-2 text-xs text-zinc-400">
                editing…
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-zinc-800 p-3">
            {range && (
              <div className="mb-2 flex items-center gap-2 text-[11px] text-[#cdf25e]">
                <span className="rounded-full bg-[#cdf25e]/15 px-2 py-0.5 font-mono">
                  {fmtTime(range.startS)}–{fmtTime(range.endS)}
                </span>
                <span className="text-zinc-500">applies to this span</span>
                <button
                  onClick={onConsumeRange}
                  className="ml-auto text-zinc-500 hover:text-zinc-300"
                  aria-label="Clear selection"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                rows={2}
                value={input}
                disabled={disabled}
                placeholder={
                  !canChat
                    ? "Waiting for the first cut…"
                    : range
                      ? "Describe the change for this span…"
                      : "Describe a change…"
                }
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
              />
              <button
                onClick={() => void send()}
                disabled={disabled || input.trim().length === 0}
                className="rounded-md bg-[#f0584d] px-3 py-2 text-sm font-medium text-white hover:bg-[#e14a40] disabled:opacity-40"
              >
                {sending ? "…" : "Send"}
              </button>
            </div>
            {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          </div>
        </>
      ) : (
        <div
          ref={logRef}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-zinc-400"
        >
          {events.length === 0 && <span className="text-zinc-600">No activity yet.</span>}
          {events
            .filter((e) => e.type !== "user_message" && e.type !== "assistant")
            .map((ev, i) => (
              <EventRow key={i} ev={ev} />
            ))}
        </div>
      )}
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

function ChatBubble({
  message,
}: {
  message: Extract<JobEvent, { type: "user_message" | "assistant" }>;
}) {
  const isUser = message.type === "user_message";
  const range = isUser ? message.range : undefined;
  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      {range && (
        <span className="rounded-full bg-[#cdf25e]/15 px-2 py-0.5 font-mono text-[10px] text-[#cdf25e]">
          {fmtTime(range.startS)}–{fmtTime(range.endS)}
        </span>
      )}
      <div
        className={
          isUser
            ? "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[#f0584d] px-3 py-2 text-sm text-white"
            : "max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
        }
      >
        {message.text}
      </div>
    </div>
  );
}

function EventRow({ ev }: { ev: JobEvent }) {
  const ts = new Date(ev.at).toLocaleTimeString();
  if (ev.type === "log") {
    const color =
      ev.level === "error"
        ? "text-red-400"
        : ev.level === "warn"
          ? "text-amber-400"
          : "text-zinc-500";
    return (
      <div className={color}>
        <span className="opacity-50">{ts}</span> {ev.message}
      </div>
    );
  }
  if (ev.type === "tool") {
    return (
      <div className="text-violet-300">
        <span className="opacity-50">{ts}</span> → {ev.tool}
        <span className="opacity-60"> {summarizeInput(ev.input)}</span>
      </div>
    );
  }
  if (ev.type === "tool_result") {
    return (
      <div className={ev.ok ? "text-emerald-400" : "text-red-400"}>
        <span className="opacity-50">{ts}</span> ← {ev.tool} {ev.summary}
      </div>
    );
  }
  if (ev.type === "timeline") {
    return (
      <div className="text-sky-300">
        <span className="opacity-50">{ts}</span> timeline: {ev.timeline.clips.length} clips,{" "}
        {ev.timeline.totalS.toFixed(1)}s
      </div>
    );
  }
  if (ev.type === "status") {
    return (
      <div className="text-blue-300">
        <span className="opacity-50">{ts}</span> status: {ev.status}
      </div>
    );
  }
  if (ev.type === "done") {
    return (
      <div className="text-zinc-300">
        <span className="opacity-50">{ts}</span> done {ev.outputPath ? "✓" : "(no output)"}
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------------- utilities */

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(obj).slice(0, 3)) {
    const v = obj[k];
    if (typeof v === "string") parts.push(`${k}=${shorten(v)}`);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(`${k}=${v}`);
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
    else parts.push(`${k}=…`);
  }
  return parts.length ? `(${parts.join(", ")})` : "";
}

function shorten(s: string): string {
  if (s.length <= 24) return s;
  return s.slice(0, 10) + "…" + s.slice(-10);
}

/* ----------------------------------------------------------------- icons */

function Icon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  if (name === "play") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M8 5v14l11-7z" fill="currentColor" />
      </svg>
    );
  }
  if (name === "pause") {
    return (
      <svg viewBox="0 0 24 24" className={className} aria-hidden>
        <path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" />
      </svg>
    );
  }
  const paths: Record<string, string> = {
    home: "M3 11l9-8 9 8M5 10v10h14V10",
    chat: "M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z",
    grid: "M4 4h16v16H4zM10 4v16M16 4v16M4 10h16M4 16h16",
    fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    download: "M12 4v12M7 11l5 5 5-5M5 20h14",
    toStart: "M6 5v14M18 5L8 12l10 7V5z",
    toEnd: "M18 5v14M6 5l10 7L6 19V5z",
    rewind: "M11 5L4 12l7 7V5zM20 5l-7 7 7 7V5z",
    ffwd: "M4 5l7 7-7 7V5zM13 5l7 7-7 7V5z",
    close: "M6 6l12 12M18 6L6 18",
    plus: "M12 5v14M5 12h14",
    audio: "M9 18V6l10-2v12M9 14a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}
