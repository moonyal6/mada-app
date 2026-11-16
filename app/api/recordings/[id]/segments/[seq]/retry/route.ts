import { cookies } from "next/headers";
import { getSegment, setSegmentStatus } from "@/lib/server/db";
import { enqueueSegment } from "@/lib/server/transcribe/queue";
import { currentClinicId } from "@/lib/server/clinic";
import { STT_COOKIE, normalizeSttChoice } from "@/lib/stt";

export const runtime = "nodejs";

/**
 * The visible retry: puts a failed segment back on the queue, under the
 * device's *current* provider choice — the usual reason to retry is having
 * just switched provider.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; seq: string }> },
) {
  const { id, seq: seqRaw } = await params;
  const seq = Number(seqRaw);
  const clinicId = await currentClinicId();
  const segment = await getSegment(clinicId, id, seq);
  if (!segment) return Response.json({ error: "not_found" }, { status: 404 });
  const preferred = normalizeSttChoice((await cookies()).get(STT_COOKIE)?.value);
  await setSegmentStatus(clinicId, id, seq, "uploaded", { error: "", provider: "", note: "", preferred });
  await enqueueSegment(clinicId, id, seq);
  return Response.json({ ok: true });
}
