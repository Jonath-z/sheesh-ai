import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { outputPath } from "@/lib/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/jobs/[id]/output">) {
  const { id } = await ctx.params;
  const filePath = outputPath(id);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return new Response("Not ready", { status: 404 });
  }

  const total = info.size;
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d+)-(\d+)?/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : total - 1;
      const chunkSize = end - start + 1;
      const node = createReadStream(filePath, { start, end });
      const web = Readable.toWeb(node) as ReadableStream<Uint8Array>;
      return new Response(web, {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${total}`,
          "accept-ranges": "bytes",
          "content-length": String(chunkSize),
          "content-type": "video/mp4",
        },
      });
    }
  }

  const node = createReadStream(filePath);
  const web = Readable.toWeb(node) as ReadableStream<Uint8Array>;
  return new Response(web, {
    headers: {
      "content-length": String(total),
      "accept-ranges": "bytes",
      "content-type": "video/mp4",
    },
  });
}
