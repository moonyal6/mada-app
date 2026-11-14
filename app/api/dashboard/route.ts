import {
  clinicToday,
  listAppointments,
  listInventory,
  listInvoices,
  listPatients,
  listSessions,
} from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";

export const runtime = "nodejs";

export async function GET() {
  const clinicId = await currentClinicId();
  const today = clinicToday();
  const patients = await listPatients(clinicId);
  const todaysAppts = await listAppointments(clinicId, today);
  const invoices = await listInvoices(clinicId);
  const inventory = await listInventory(clinicId);
  return Response.json({
    today,
    patients,
    todaysAppts,
    sessionsCount: (await listSessions(clinicId)).filter((s) => s.status === "final").length,
    income: invoices.filter((i) => i.paid).reduce((s, i) => s + i.total, 0),
    lowStock: inventory.filter((i) => i.qty <= i.min),
    counts: {
      patients: patients.length,
      apptsToday: todaysAppts.filter((a) => a.status === "محجوز").length,
      lowStock: inventory.filter((i) => i.qty <= i.min).length,
    },
  });
}
