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

/** Escape hatch: flip to true to run the mic on the scripted simulation
 *  (no microphone, no permission prompt) instead of Web Speech recognition —
 *  e.g. if ar-SA recognition proves unusable on the clinic's machine. */
export const VOICE_SIMULATION = false;
