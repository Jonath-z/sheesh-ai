"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [footage, setFootage] = useState<File[]>([]);
  const [broll, setBroll] = useState<File[]>([]);
  const [reference, setReference] = useState<File | null>(null);
  const [referenceUrl, setReferenceUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (footage.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of footage) form.append("footage", f);
      for (const f of broll) form.append("broll", f);
      if (reference) {
        form.append("reference", reference);
      } else if (referenceUrl.trim()) {
        form.append("reference_url", referenceUrl.trim());
      }
      const res = await fetch("/api/jobs", { method: "POST", body: form });
      const data = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !data.jobId) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      router.push(`/job/${data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-16">
        <header className="flex flex-col gap-2">
          <span className="text-xs font-medium uppercase tracking-widest text-zinc-500">
            agentic
          </span>
          <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
            Video Editor
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Drop in raw footage and an optional reference. Claude probes the
            clips, picks the moments, and assembles a cut.
          </p>
        </header>

        <form onSubmit={onSubmit} className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <legend className="px-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
              Footage
            </legend>
            <input
              type="file"
              accept="video/*"
              multiple
              required
              onChange={(e) => setFootage(Array.from(e.target.files ?? []))}
              className="text-sm file:mr-4 file:rounded-full file:border-0 file:bg-zinc-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-zinc-700 dark:file:bg-zinc-100 dark:file:text-zinc-900 dark:hover:file:bg-zinc-300"
            />
            {footage.length > 0 && (
              <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {footage.map((f) => (
                  <li key={f.name + f.size} className="truncate">
                    {f.name} <span className="opacity-60">({prettySize(f.size)})</span>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <legend className="px-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
              B-roll (optional)
            </legend>
            <p className="text-xs text-zinc-500">
              Cutaway footage the agent can lay over your main clips while the
              original audio keeps playing.
            </p>
            <input
              type="file"
              accept="video/*"
              multiple
              onChange={(e) => setBroll(Array.from(e.target.files ?? []))}
              className="text-sm file:mr-4 file:rounded-full file:border-0 file:bg-zinc-200 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-900 hover:file:bg-zinc-300 dark:file:bg-zinc-800 dark:file:text-zinc-100 dark:hover:file:bg-zinc-700"
            />
            {broll.length > 0 && (
              <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {broll.map((f) => (
                  <li key={f.name + f.size} className="truncate">
                    {f.name} <span className="opacity-60">({prettySize(f.size)})</span>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <legend className="px-2 text-xs font-medium uppercase tracking-widest text-zinc-500">
              Reference (optional)
            </legend>
            <p className="text-xs text-zinc-500">
              A clip in the style you want — the agent matches its pacing and aspect ratio. Either upload a file <em>or</em> paste a YouTube link.
            </p>
            <div className="flex flex-col gap-2">
              <input
                type="file"
                accept="video/*"
                disabled={referenceUrl.trim().length > 0}
                onChange={(e) => setReference(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-4 file:rounded-full file:border-0 file:bg-zinc-200 file:px-4 file:py-2 file:text-sm file:font-medium file:text-zinc-900 hover:file:bg-zinc-300 disabled:opacity-40 dark:file:bg-zinc-800 dark:file:text-zinc-100 dark:hover:file:bg-zinc-700"
              />
              {reference && (
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  {reference.name} <span className="opacity-60">({prettySize(reference.size)})</span>
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest text-zinc-400">
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
              <span>or</span>
              <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
            </div>
            <div className="flex flex-col gap-1">
              <input
                type="url"
                placeholder="https://youtube.com/shorts/…"
                value={referenceUrl}
                disabled={!!reference}
                onChange={(e) => setReferenceUrl(e.target.value)}
                className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:placeholder:text-zinc-600"
              />
              <p className="text-xs text-zinc-500">
                We&apos;ll download the video at 720p to use as the style reference. Use videos you have rights to draw inspiration from.
              </p>
            </div>
          </fieldset>

          {error && (
            <p className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || footage.length === 0}
            className="self-start rounded-full bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {submitting ? "Uploading…" : "Start editing"}
          </button>
        </form>
      </main>
    </div>
  );
}

function prettySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
