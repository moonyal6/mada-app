import { getPatient, getSession, patchSession } from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";
import type { SessionDraftPatch } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clinicId = await currentClinicId();
  const session = await getSession(clinicId, id);
  if (!session) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ session, patient: await getPatient(clinicId, session.patientId) });
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
  const clinicId = await currentClinicId();
  // THROWAWAY: route guard removed, so patchSession's own filter is all that's left
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
  if (Array.isArray(body.suggestedDx)) {
    patch.suggestedDx = body.suggestedDx.filter(
      (x): x is string => typeof x === "string",
    );
  }

  const session = await patchSession(clinicId, id, patch);
  return Response.json({ session });
}
