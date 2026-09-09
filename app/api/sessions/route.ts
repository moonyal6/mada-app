import { cookies } from "next/headers";
import { createSession, getPatient, listSessions } from "@/lib/server/db";
import {
  THERAPIST_COOKIE,
  decodeTherapistCookie,
  normalizeTherapist,
} from "@/lib/therapist";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const patientId =
    new URL(request.url).searchParams.get("patientId") ?? undefined;
  return Response.json({ sessions: listSessions(patientId) });
}

/**
 * Start a fresh draft session for a patient, stamped with the therapist
 * running it: an explicit `therapistName` in the body, else the device's
 * chosen name (cookie), else empty (displays as the configured fallback).
 */
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
  const therapistName =
    normalizeTherapist(body.therapistName) ||
    decodeTherapistCookie((await cookies()).get(THERAPIST_COOKIE)?.value);
  return Response.json(
    { session: createSession(patientId, therapistName) },
    { status: 201 },
  );
}
