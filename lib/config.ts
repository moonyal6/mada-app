/**
 * Identity + brand strings. These are constants for now; when authentication
 * lands, the doctor block is what gets replaced with the signed-in user.
 */
export const DOCTOR = {
  name: "د. عبدالرحمن التركي",
  initials: "عت",
  specialty: "علاج طبيعي",
} as const;

export const BRAND = {
  name: "مدى",
  nameNote: "· اسم مبدئي",
  tagline: "طبقة ذكاء رقيقة بجانب المعالج",
  badge: "نسخة تجريبية",
  handoutTitle: "نشرة البرنامج المنزلي",
} as const;
