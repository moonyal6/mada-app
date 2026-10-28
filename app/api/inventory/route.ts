import { createInventoryItem, listInventory } from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ inventory: listInventory() });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return Response.json({ error: "invalid_body" }, { status: 400 });
  const item = createInventoryItem({
    name,
    qty: typeof body.qty === "number" && body.qty >= 0 ? Math.floor(body.qty) : 0,
    min: typeof body.min === "number" && body.min >= 0 ? Math.floor(body.min) : 0,
    unit:
      typeof body.unit === "string" && body.unit.trim() ? body.unit.trim() : "حبة",
  });
  return Response.json({ item }, { status: 201 });
}
