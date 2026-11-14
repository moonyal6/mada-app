import {
  getPatient,
  listAppointments,
  listInvoices,
  listSessions,
} from "@/lib/server/db";
import { adherenceForPatient } from "@/lib/server/adherence";
import { currentClinicId } from "@/lib/server/clinic";

export const runtime = "nodejs";

/** Everything the patient-detail screen needs in one call. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clinicId = await currentClinicId();
  const patient = await getPatient(clinicId, id);
  if (!patient) return Response.json({ error: "not_found" }, { status: 404 });
  const appointments = (await listAppointments(clinicId))
    .filter((a) => a.patientId === id)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  return Response.json({
    patient,
    appointments,
    sessions: await listSessions(clinicId, id),
    invoices: await listInvoices(clinicId, id),
    adherence: await adherenceForPatient(clinicId, id),
  });
}
