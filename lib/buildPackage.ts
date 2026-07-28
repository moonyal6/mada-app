import { CASES } from "./data/cases";
import type { SessionState } from "./types";

/**
 * Assembles the text package that gets handed to the writing step.
 *
 * The output is byte-identical to the MVP's buildPackage(): same labels, same
 * "—" placeholders, same ordering, same blank lines. Anything that changes the
 * string changes what the doctor sees in the preview and what the model reads.
 */
export function buildPackage(state: SessionState): string {
  const p = state.patient;
  const d = state.doctor;
  const exs = Object.values(state.selected);

  const exText = exs.length
    ? exs.map((e) => `- ${e.ar}${e.en ? ` (${e.en})` : ""}`).join("\n")
    : "—";

  const L = (lbl: string, val: string) =>
    `${lbl}: ${val && String(val).trim() ? val : "—"}`;

  const dateFmt = d.date
    ? new Date(d.date).toLocaleDateString("ar-SA-u-ca-gregory", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "—";

  const planBits: string[] = [];
  if (d.sessions) planBits.push(d.sessions);
  if (d.frequency) planBits.push(d.frequency);
  let plan = planBits.join("، ");
  if (d.home) plan += (plan ? " + " : "") + `برنامج منزلي ${d.home}`;
  if (d.planNotes && d.planNotes.trim())
    plan += (plan ? ". " : "") + d.planNotes.trim();

  return `بيانات المريض:
- ${L("الاسم", p.name)}
- ${L("العمر", p.age)}
- ${L("الجنس", p.sex)}
- ${L("نوع الحالة", CASES[p.caseKey].label)}
- ${L("الشكوى الرئيسية", p.complaint)}

نص حوار الجلسة:
${state.dialogue.trim() || "—"}

رأي الطبيب المعالج:
- ${L("التشخيص", d.dx)}
- ${L("تاريخ الجلسة", dateFmt)}
- ${L("خطة العلاج", plan)}
- ${L("شدة الألم", d.pain)}
- ${L("المتابعة", d.follow)}

نصائح وإرشادات للمريض:
${d.advice.trim() || "—"}

التمارين المختارة:
${exText}`;
}
