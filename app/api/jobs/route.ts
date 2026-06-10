import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createJob, referenceUrlFile, workspaceDirs } from "@/lib/jobs";
import { runEditorAgent } from "@/lib/agent";
import { validateYouTubeUrl } from "@/lib/youtube";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;

function safeName(name: string, fallback: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return VIDEO_EXT.test(base) ? base : `${fallback}.mp4`;
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (e) {
    return Response.json({ error: `Invalid form: ${String(e)}` }, { status: 400 });
  }

  const footage = form.getAll("footage").filter((v): v is File => v instanceof File);
  const referenceField = form.get("reference");
  const reference = referenceField instanceof File && referenceField.size > 0 ? referenceField : null;
  const referenceUrlField = form.get("reference_url");
  const rawReferenceUrl =
    typeof referenceUrlField === "string" ? referenceUrlField.trim() : "";

  if (footage.length === 0) {
    return Response.json({ error: "Upload at least one footage clip" }, { status: 400 });
  }

  let validatedUrl: string | null = null;
  if (rawReferenceUrl) {
    try {
      validatedUrl = validateYouTubeUrl(rawReferenceUrl);
    } catch (e) {
      return Response.json(
        { error: `Invalid YouTube URL: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      );
    }
  }

  const jobId = await createJob();
  const dirs = workspaceDirs(jobId);

  let idx = 0;
  for (const f of footage) {
    const buf = Buffer.from(await f.arrayBuffer());
    const name = safeName(f.name, `footage_${String(idx).padStart(2, "0")}`);
    await writeFile(path.join(dirs.raw, `${String(idx).padStart(2, "0")}_${name}`), buf);
    idx++;
  }

  if (reference) {
    const buf = Buffer.from(await reference.arrayBuffer());
    await writeFile(path.join(dirs.reference, safeName(reference.name, "reference")), buf);
  } else if (validatedUrl) {
    // Persist the URL; the agent picks it up at startup and downloads it so
    // the user sees download progress in the SSE stream.
    await writeFile(referenceUrlFile(jobId), validatedUrl, "utf8");
  }

  void runEditorAgent(jobId).catch(() => {});

  return Response.json({ jobId }, { status: 201 });
}
