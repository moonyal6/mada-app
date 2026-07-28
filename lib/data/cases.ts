export const CASES = {
  back: { label: "آلام أسفل الظهر", region: "العمود الفقري القطني" },
  neck: { label: "آلام الرقبة", region: "الفقرات العنقية" },
  neckstrain: { label: "شدّ عضلات الرقبة", region: "عضلات الرقبة وأعلى الظهر" },
  shoulder: { label: "إصابات الكتف", region: "مفصل الكتف" },
  knee: { label: "إصابات الركبة", region: "مفصل الركبة" },
  ankle: { label: "إصابات الكاحل", region: "مفصل الكاحل" },
  postop: { label: "إعادة تأهيل ما بعد الجراحة", region: "حسب موقع الجراحة" },
} as const;

export type CaseKey = keyof typeof CASES;

export const CASE_KEYS = Object.keys(CASES) as CaseKey[];

export function isCaseKey(value: string): value is CaseKey {
  return value in CASES;
}
