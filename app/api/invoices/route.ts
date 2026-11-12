import { clinicToday, createInvoice, listInvoices } from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ invoices: await listInvoices() });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const patientId = body.patientId;
  const desc =
    typeof body.desc === "string" && body.desc.trim()
      ? body.desc.trim()
      : "جلسة";
  const amount = typeof body.amount === "number" && body.amount >= 0 ? body.amount : 0;
  const paid = body.paid === true;
  if (typeof patientId !== "string" || !patientId) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const invoice = await createInvoice(await currentClinicId(), {
    patientId,
    date: clinicToday(),
    items: [{ desc, amount }],
    total: amount,
    paid,
  });
  return Response.json({ invoice }, { status: 201 });
}
