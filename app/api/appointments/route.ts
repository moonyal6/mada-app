import { createAppointment, listAppointments } from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date") ?? undefined;
  return Response.json({ appointments: await listAppointments(date) });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { patientId, date, time, type } = body;
  if (
    typeof patientId !== "string" ||
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof time !== "string" ||
    !time ||
    typeof type !== "string" ||
    !type
  ) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const appointment = await createAppointment({ patientId, date, time, type });
  return Response.json({ appointment }, { status: 201 });
}
