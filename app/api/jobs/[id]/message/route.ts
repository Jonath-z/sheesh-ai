import type { NextRequest } from "next/server";
import { loadJob } from "@/lib/jobs";
import { sendAgentMessage } from "@/lib/agent";
import type { VideoRange } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseRange(value: unknown): VideoRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { startS, endS } = value as Record<string, unknown>;
  if (typeof startS !== "number" || typeof endS !== "number") return undefined;
  if (!Number.isFinite(startS) || !Number.isFinite(endS)) return undefined;
  if (startS < 0 || endS <= startS) return undefined;
  return { startS, endS };
}

export async function POST(
  req: NextRequest,
  ctx: RouteContext<"/api/jobs/[id]/message">,
) {
  const { id } = await ctx.params;
  const job = await loadJob(id);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  if (!job.sessionId) {
    return Response.json(
      { error: "The first edit hasn't finished yet — try again in a moment." },
      { status: 409 },
    );
  }
  if (job.status === "running") {
    return Response.json(
      { error: "The agent is still working on the previous request." },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const text =
    typeof (body as { text?: unknown })?.text === "string"
      ? (body as { text: string }).text.trim()
      : "";
  if (!text)
    return Response.json(
      { error: "Message text is required" },
      { status: 400 },
    );
  if (text.length > 2000) {
    return Response.json(
      { error: "Message is too long (2000 char max)" },
      { status: 400 },
    );
  }
  const range = parseRange((body as { range?: unknown }).range);

  // Fire-and-forget: the turn streams its events over the job's SSE channel.
  void sendAgentMessage(id, text, range).catch(() => {});

  return Response.json({ accepted: true }, { status: 202 });
}
