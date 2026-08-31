import { listPatients } from "@/lib/server/db";
import { adherenceForPatient } from "@/lib/server/adherence";

export const runtime = "nodejs";

/** Follow-up rows: active patients + adherence computed from patient logs. */
export async function GET() {
  const rows = listPatients()
    .filter((p) => p.status !== "منتهٍ")
    .map((p) => ({ patient: p, adherence: adherenceForPatient(p.id) }));
  return Response.json({ rows });
}
