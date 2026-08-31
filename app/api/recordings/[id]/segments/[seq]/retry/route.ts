import { getSegment, setSegmentStatus } from "@/lib/server/db";
import { enqueueSegment } from "@/lib/server/transcribe/queue";

export const runtime = "nodejs";

/** The visible retry: puts a failed segment back on the queue. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; seq: string }> },
) {
  const { id, seq: seqRaw } = await params;
  const seq = Number(seqRaw);
  const segment = getSegment(id, seq);
  if (!segment) return Response.json({ error: "not_found" }, { status: 404 });
  setSegmentStatus(id, seq, "uploaded", { error: "" });
  enqueueSegment(id, seq);
  return Response.json({ ok: true });
}
