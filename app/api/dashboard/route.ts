import {
  clinicToday,
  listAppointments,
  listInventory,
  listInvoices,
  listPatients,
  listSessions,
} from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET() {
  const today = clinicToday();
  const patients = listPatients();
  const todaysAppts = listAppointments(today);
  const invoices = listInvoices();
  const inventory = listInventory();
  return Response.json({
    today,
    patients,
    todaysAppts,
    sessionsCount: listSessions().filter((s) => s.status === "final").length,
    income: invoices.filter((i) => i.paid).reduce((s, i) => s + i.total, 0),
    lowStock: inventory.filter((i) => i.qty <= i.min),
    counts: {
      patients: patients.length,
      apptsToday: todaysAppts.filter((a) => a.status === "محجوز").length,
      lowStock: inventory.filter((i) => i.qty <= i.min).length,
    },
  });
}
