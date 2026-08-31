import { createSession, getPatient, listSessions } from "@/lib/server/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const patientId =
    new URL(request.url).searchParams.get("patientId") ?? undefined;
  return Response.json({ sessions: listSessions(patientId) });
}

/** Start a fresh draft session for a patient. */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const patientId = body.patientId;
  if (typeof patientId !== "string" || !getPatient(patientId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ session: createSession(patientId) }, { status: 201 });
}
