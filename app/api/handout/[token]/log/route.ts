import {
  clinicToday,
  getSessionByToken,
  setAdherence,
  setPainLog,
} from "@/lib/server/db";

export const runtime = "nodejs";

/**
 * The patient page writes here: exercise check-offs and the daily pain score.
 * Only "today" (clinic timezone) is accepted — the handout is a daily log,
 * not a backfill tool.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = await getSessionByToken(token);
  if (!session) return Response.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const day = clinicToday();
  const exCount = Object.keys(session.selected).length;

  if (typeof body.exIdx === "number") {
    const exIdx = Math.floor(body.exIdx);
    if (exIdx < 0 || exIdx >= exCount) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    await setAdherence(session.id, day, exIdx, body.done !== false);
    return Response.json({ ok: true, day });
  }

  if (typeof body.pain === "number") {
    const pain = Math.round(body.pain);
    if (pain < 0 || pain > 10) {
      return Response.json({ error: "invalid_body" }, { status: 400 });
    }
    await setPainLog(session.id, day, pain);
    return Response.json({ ok: true, day });
  }

  return Response.json({ error: "invalid_body" }, { status: 400 });
}
