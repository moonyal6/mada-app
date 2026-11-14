import { adjustInventory } from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";

export const runtime = "nodejs";

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
  const delta = body.delta;
  if (typeof delta !== "number" || !Number.isFinite(delta)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (!(await adjustInventory(await currentClinicId(), id, Math.trunc(delta)))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
