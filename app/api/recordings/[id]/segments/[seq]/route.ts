import fs from "node:fs/promises";
import { getRecording, segmentPath, upsertSegment } from "@/lib/server/db";
import { enqueueSegment } from "@/lib/server/transcribe/queue";

export const runtime = "nodejs";

/** ~20s of opus is well under 1MB; anything huge is a client bug. */
const MAX_SEGMENT_BYTES = 15 * 1024 * 1024;

function extFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/**
 * Raw-body segment upload. Idempotent per (recording, seq) so the client can
 * retry the same segment after a network drop without duplicating anything.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; seq: string }> },
) {
  const { id, seq: seqRaw } = await params;
  const seq = Number(seqRaw);
  if (!Number.isInteger(seq) || seq < 0 || seq > 100_000) {
    return Response.json({ error: "invalid_seq" }, { status: 400 });
  }
  const recording = getRecording(id);
  if (!recording) return Response.json({ error: "not_found" }, { status: 404 });

  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.byteLength === 0) {
    return Response.json({ error: "empty_body" }, { status: 400 });
  }
  if (buf.byteLength > MAX_SEGMENT_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  await fs.writeFile(segmentPath(id, seq, extFor(recording.mime)), buf);
  upsertSegment(id, seq, buf.byteLength);
  enqueueSegment(id, seq);
  return Response.json({ ok: true, seq });
}
