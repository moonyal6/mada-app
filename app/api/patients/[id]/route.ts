import {
  getPatient,
  listAppointments,
  listInvoices,
  listSessions,
} from "@/lib/server/db";
import { adherenceForPatient } from "@/lib/server/adherence";

export const runtime = "nodejs";

/** Everything the patient-detail screen needs in one call. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const patient = getPatient(id);
  if (!patient) return Response.json({ error: "not_found" }, { status: 404 });
  const appointments = listAppointments()
    .filter((a) => a.patientId === id)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return Response.json({
    patient,
    appointments,
    sessions: listSessions(id),
    invoices: listInvoices(id),
    adherence: adherenceForPatient(id),
  });
}
