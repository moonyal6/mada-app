import { listPatients } from "@/lib/server/db";
import { adherenceForPatient } from "@/lib/server/adherence";
import { currentClinicId } from "@/lib/server/clinic";

export const runtime = "nodejs";

/** Follow-up rows: active patients + adherence computed from patient logs. */
export async function GET() {
  const clinicId = await currentClinicId();
  const rows = await Promise.all(
    (await listPatients(clinicId))
      .filter((p) => p.status !== "منتهٍ")
      .map(async (p) => ({ patient: p, adherence: await adherenceForPatient(clinicId, p.id) })),
  );
  return Response.json({ rows });
}
