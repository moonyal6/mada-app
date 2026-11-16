import { clinicToday, withHandout } from "@/lib/server/db";

export const runtime = "nodejs";

// The token is the credential: both writes run in the clinic of the session
// it resolves, in one transaction (withHandout, #10 D5).

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

  // Read before the transaction opens, so a slow body never holds a pooled
  // connection. An unknown token still answers 404 first, as before.
  let body: Record<string, unknown> | undefined;
  try {
    body = await request.json();
  } catch {
    body = undefined;
  }

  const res = await withHandout(token, async (h) => {
    if (body === undefined) {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const day = clinicToday();
    const exCount = Object.keys(h.session.selected).length;

    if (typeof body.exIdx === "number") {
      const exIdx = Math.floor(body.exIdx);
      if (exIdx < 0 || exIdx >= exCount) {
        return Response.json({ error: "invalid_body" }, { status: 400 });
      }
      await h.setAdherence(day, exIdx, body.done !== false);
      return Response.json({ ok: true, day });
    }

    if (typeof body.pain === "number") {
      const pain = Math.round(body.pain);
      if (pain < 0 || pain > 10) {
        return Response.json({ error: "invalid_body" }, { status: 400 });
      }
      await h.setPainLog(day, pain);
      return Response.json({ ok: true, day });
    }

    return Response.json({ error: "invalid_body" }, { status: 400 });
  });
  return res ?? Response.json({ error: "not_found" }, { status: 404 });
}
