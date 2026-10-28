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
  const patient = await getPatient(id);
  if (!patient) return Response.json({ error: "not_found" }, { status: 404 });
  const appointments = (await listAppointments())
    .filter((a) => a.patientId === id)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return Response.json({
    patient,
    appointments,
    sessions: await listSessions(id),
    invoices: await listInvoices(id),
    adherence: await adherenceForPatient(id),
  });
}
