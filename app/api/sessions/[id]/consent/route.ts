import { getSession, setSessionConsent } from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";

export const runtime = "nodejs";

/** Records that recording consent was explained and given, with a timestamp. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clinicId = await currentClinicId();
  if (!(await getSession(clinicId, id))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ session: await setSessionConsent(clinicId, id) });
}
