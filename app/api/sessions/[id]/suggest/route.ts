import { getPatient, getSession } from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";
import { claudeText } from "@/lib/server/claude";
import { SUGGEST_SYS } from "@/lib/prompts";
import { caseLabel } from "@/lib/format";

export const runtime = "nodejs";

const MAX_DIALOGUE_CHARS = 60_000;

/**
 * Suggest an assessment summary + clinical impressions from the dialogue.
 * Everything returned is a draft the therapist reviews — the UI keeps that
 * framing; this route never writes to the session.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const clinicId = await currentClinicId();
  const session = await getSession(clinicId, id);
  if (!session) return Response.json({ error: "not_found" }, { status: 404 });
  const patient = await getPatient(clinicId, session.patientId);
  if (!patient) return Response.json({ error: "not_found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  // The client sends its live dialogue — fresher than the last autosave.
  const dialogue =
    typeof body.dialogue === "string" ? body.dialogue : session.dialogue;
  if (!dialogue.trim()) {
    return Response.json({ error: "empty_dialogue" }, { status: 422 });
  }
  if (dialogue.length > MAX_DIALOGUE_CHARS) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  const user = `بيانات الحالة:
- نوع الحالة: ${caseLabel(patient.caseKey)}
- العمر: ${patient.age ?? "—"} · الجنس: ${patient.sex || "—"}
- الشكوى الرئيسية: ${patient.complaint || "—"}

نص حوار الجلسة:
${dialogue.trim()}`;

  const result = await claudeText({ system: SUGGEST_SYS, user, maxTokens: 2000 });
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: 502 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text.replace(/```json|```/g, "").trim());
  } catch {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }
  const record = parsed as { assessment?: unknown; impressions?: unknown };
  const assessment =
    typeof record.assessment === "string" ? record.assessment.trim() : "";
  const impressions = Array.isArray(record.impressions)
    ? record.impressions
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .slice(0, 3)
    : [];
  if (!assessment && !impressions.length) {
    return Response.json({ error: "insufficient" }, { status: 422 });
  }
  return Response.json({ assessment, impressions });
}
