import { getSession, patchSession } from "@/lib/server/db";
import type { SessionDraftPatch } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ session });
}

const STRING_FIELDS = [
  "dialogue",
  "assessment",
  "dx",
  "date",
  "sessionsCount",
  "frequency",
  "home",
  "follow",
  "pain",
  "advice",
  "planNotes",
  "report",
  "sealDate",
] as const;

/** Draft autosave. Only whitelisted fields ever reach the row. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getSession(id)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const patch: SessionDraftPatch = {};
  for (const f of STRING_FIELDS) {
    if (typeof body[f] === "string") patch[f] = body[f] as string;
  }
  if (typeof body.step === "number" && body.step >= 0 && body.step <= 3) {
    patch.step = Math.floor(body.step);
  }
  if (typeof body.sealed === "boolean") patch.sealed = body.sealed;
  if (body.selected && typeof body.selected === "object") {
    patch.selected = body.selected as SessionDraftPatch["selected"];
  }

  const session = patchSession(id, patch);
  return Response.json({ session });
}
