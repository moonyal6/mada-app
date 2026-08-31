import { createRecording, getSession } from "@/lib/server/db";

export const runtime = "nodejs";

/** Open a recording for a session. Refused until consent is on record. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const sessionId = body.sessionId;
  const mime = typeof body.mime === "string" ? body.mime.slice(0, 100) : "";
  if (typeof sessionId !== "string") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const session = getSession(sessionId);
  if (!session) return Response.json({ error: "not_found" }, { status: 404 });
  if (!session.consentAt) {
    return Response.json({ error: "consent_required" }, { status: 409 });
  }
  return Response.json({ id: createRecording(sessionId, mime) }, { status: 201 });
}
