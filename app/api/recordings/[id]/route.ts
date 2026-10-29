import { getRecording, listSegments } from "@/lib/server/db";
import { recoverPending } from "@/lib/server/transcribe/queue";

export const runtime = "nodejs";

/** Segment statuses + texts. The recorder polls this while recording. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const recording = await getRecording(id);
  if (!recording) return Response.json({ error: "not_found" }, { status: 404 });
  // A restart may have orphaned pending segments — make sure they're queued.
  await recoverPending();
  return Response.json({
    id,
    sessionId: recording.sessionId,
    segments: await listSegments(id),
  });
}
