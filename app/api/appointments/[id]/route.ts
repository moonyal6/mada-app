import { setAppointmentStatus } from "@/lib/server/db";

export const runtime = "nodejs";

const ALLOWED = new Set(["محجوز", "حضر", "ملغى"]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const status = body.status;
  if (typeof status !== "string" || !ALLOWED.has(status)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!(await setAppointmentStatus(id, status))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
