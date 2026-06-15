import type { NextRequest } from "next/server";
import { getProvenance, loadJob } from "@/lib/jobs";
import { manualRetrim } from "@/lib/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]/retrim">) {
  const { id } = await ctx.params;
  const job = await loadJob(id);
  if (!job) return Response.json({ error: "Job not found" }, { status: 404 });
  if (job.status === "running") {
    return Response.json({ error: "An edit is already in progress." }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { clipName, inS, outS } = (body ?? {}) as {
    clipName?: unknown;
    inS?: unknown;
    outS?: unknown;
  };
  if (typeof clipName !== "string" || !clipName) {
    return Response.json({ error: "clipName is required" }, { status: 400 });
  }
  if (
    typeof inS !== "number" ||
    typeof outS !== "number" ||
    !Number.isFinite(inS) ||
    !Number.isFinite(outS) ||
    inS < 0 ||
    outS <= inS
  ) {
    return Response.json({ error: "Invalid in/out range" }, { status: 400 });
  }

  // Only plain trimmed clips can be adjusted deterministically; reject up front
  // so the user gets immediate feedback instead of a silent no-op.
  const prov = getProvenance(id)[clipName];
  if (!prov || prov.kind !== "trim") {
    return Response.json(
      { error: "This clip has effects or is generated — adjust it via the Assistant." },
      { status: 409 },
    );
  }

  // Fire-and-forget: progress + the new cut stream over the job's SSE channel.
  void manualRetrim(id, clipName, inS, outS).catch(() => {});
  return Response.json({ accepted: true }, { status: 202 });
}
