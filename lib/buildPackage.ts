import type { ClinicalSession, Patient } from "./types";
import { caseLabel, fmtDate } from "./format";

/**
 * The drafting package — what gets sent to the report writer. The text
 * format is verbatim from the prototype's buildPackage(); the therapist sees
 * exactly this block before generating.
 */
export function buildPackage(p: Patient, sess: ClinicalSession): string {
  const L = (l: string, v: unknown) =>
    `${l}: ${v != null && String(v).trim() ? v : "—"}`;
  const exs = Object.values(sess.selected);
  let plan = [sess.sessionsCount, sess.frequency].filter(Boolean).join("، ");
  if (sess.home) plan += (plan ? " + " : "") + `برنامج منزلي ${sess.home}`;
  if (sess.planNotes) plan += (plan ? ". " : "") + sess.planNotes;
  return `بيانات المريض:
- ${L("الاسم", p.name)}
- ${L("العمر", p.age)}
- ${L("الجنس", p.sex)}
- ${L("نوع الحالة", caseLabel(p.caseKey))}
- ${L("الشكوى الرئيسية", p.complaint)}

نص حوار الجلسة:
${sess.dialogue.trim() || "—"}

ملخّص التقييم:
${sess.assessment.trim() || "—"}

رأي الطبيب المعالج:
- ${L("التشخيص", sess.dx)}
- ${L("تاريخ الجلسة", fmtDate(sess.date))}
- ${L("خطة العلاج", plan)}
- ${L("شدة الألم", sess.pain)}
- ${L("المتابعة", sess.follow)}

نصائح وإرشادات للمريض:
${sess.advice.trim() || "—"}

التمارين المختارة:
${exs.length ? exs.map((e) => `- ${e.ar}${e.en ? ` (${e.en})` : ""}`).join("\n") : "—"}`;
}
