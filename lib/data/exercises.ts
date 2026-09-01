import type { CaseKey } from "./cases";
import type { LibraryExercise } from "../types";

/**
 * The exercise library — the app's only source of exercise content.
 *
 * ⚠️ PLACEHOLDER CLINICAL CONTENT: every `desc` below is draft wording for
 * the clinical lead to review and replace before any patient sees it. The
 * illustrations under /public/exercises are schematic placeholders, not
 * approved clinical art.
 *
 * `video` is the URL the handout QR encodes. These are real, working links to
 * publicly available demonstration videos, standing in until the clinic
 * records or approves its own (unlisted) versions. An empty string renders an
 * honest "no video" tile — never a QR that scans into nothing.
 */
export const EX: Record<CaseKey, LibraryExercise[]> = {
  back: [
    {
      id: "back-pelvic-tilt",
      ar: "إمالة الحوض",
      en: "Pelvic Tilt",
      desc: "شدّ لطيف لعضلات البطن مع تسطيح أسفل الظهر على الأرض.",
      video: "https://www.youtube.com/watch?v=2oDtowdT9-8",
      image: "/exercises/back-pelvic-tilt.svg",
    },
    {
      id: "back-cat-cow",
      ar: "القطة والبقرة",
      en: "Cat–Cow",
      desc: "تبديل بين تقويس الظهر وتحديبه لتحسين مرونة العمود الفقري.",
      video: "https://www.youtube.com/watch?v=fcnv4gyMzf8",
      image: "/exercises/back-cat-cow.svg",
    },
    {
      id: "back-bridge",
      ar: "تمرين الجسر",
      en: "Bridging",
      desc: "رفع الحوض مع ثبات القدمين لتقوية الألوية وأسفل الظهر.",
      video: "https://www.youtube.com/watch?v=9tUOelaOEHM",
      image: "/exercises/back-bridge.svg",
    },
    {
      id: "back-knee-to-chest",
      ar: "شدّ الركبة للصدر",
      en: "Knee-to-Chest",
      desc: "تقريب الركبة نحو الصدر لإطالة عضلات أسفل الظهر.",
      video: "https://www.youtube.com/watch?v=1UVIT5G1R2k",
      image: "/exercises/back-knee-to-chest.svg",
    },
    {
      id: "back-bird-dog",
      ar: "الطائر والكلب",
      en: "Bird-Dog",
      desc: "مدّ ذراع وساق متقابلتين مع ثبات الجذع لتحسين الاتزان.",
      video: "https://www.youtube.com/watch?v=ufCbCMlJLAs",
      image: "/exercises/back-bird-dog.svg",
    },
  ],
  neck: [
    {
      id: "neck-chin-tuck",
      ar: "شدّ الذقن (الانكماش العنقي)",
      en: "Chin Tuck",
      desc: "سحب الذقن للخلف لمحاذاة الرأس فوق الكتفين.",
      video: "https://www.youtube.com/watch?v=LkLed6m3twY",
      image: "/exercises/neck-chin-tuck.svg",
    },
    {
      id: "neck-lateral-flexion",
      ar: "الإمالة الجانبية للرقبة",
      en: "Lateral Neck Flexion",
      desc: "إمالة الرأس نحو الكتف لإطالة الجانب المقابل.",
      video: "https://www.youtube.com/watch?v=t_q9JQh_-7A",
      image: "/exercises/neck-lateral-flexion.svg",
    },
    {
      id: "neck-rotation",
      ar: "دوران الرقبة",
      en: "Neck Rotation",
      desc: "إدارة الرأس ببطء يميناً ويساراً ضمن المدى المريح.",
      video: "https://www.youtube.com/watch?v=dVjexqdvWqk",
      image: "/exercises/neck-rotation.svg",
    },
    {
      id: "neck-upper-trap-stretch",
      ar: "إطالة العضلة شبه المنحرفة العلوية",
      en: "Upper Trapezius Stretch",
      desc: "إمالة الرأس مع سحب لطيف لإرخاء أعلى الكتف.",
      video: "https://www.youtube.com/watch?v=uwLcpgIqpnU",
      image: "/exercises/neck-upper-trap-stretch.svg",
    },
  ],
  neckstrain: [
    {
      id: "neckstrain-upper-trap-stretch",
      ar: "إطالة العضلة شبه المنحرفة العلوية",
      en: "Upper Trapezius Stretch",
      desc: "إمالة الرأس نحو الجانب مع سحب لطيف لإرخاء أعلى الكتف.",
      video: "https://www.youtube.com/watch?v=uwLcpgIqpnU",
      image: "/exercises/neck-upper-trap-stretch.svg",
    },
    {
      id: "neckstrain-levator-stretch",
      ar: "إطالة العضلة الرافعة للكتف",
      en: "Levator Scapulae Stretch",
      desc: "إدارة الرأس للأسفل جانبياً لإطالة العضلة الرافعة للكتف.",
      video: "https://www.youtube.com/watch?v=qm_8JBo7kF0",
      image: "/exercises/neckstrain-levator-stretch.svg",
    },
    {
      id: "neckstrain-shoulder-rolls",
      ar: "لفّ الكتفين للخلف",
      en: "Shoulder Rolls",
      desc: "تدوير الكتفين للخلف لإرخاء التوتر العضلي أعلى الظهر.",
      video: "https://www.youtube.com/watch?v=VikUs5HH8cc",
      image: "/exercises/neckstrain-shoulder-rolls.svg",
    },
    {
      id: "neckstrain-chin-tuck",
      ar: "شدّ الذقن (الانكماش العنقي)",
      en: "Chin Tuck",
      desc: "سحب الذقن للخلف لتصحيح وضع الرأس وتخفيف الحمل العضلي.",
      video: "https://www.youtube.com/watch?v=LkLed6m3twY",
      image: "/exercises/neck-chin-tuck.svg",
    },
    {
      id: "neckstrain-scalene-stretch",
      ar: "إطالة العضلات الأخمعية",
      en: "Scalene Stretch",
      desc: "إمالة الرأس مع تثبيت الترقوة لإطالة جانب الرقبة الأمامي.",
      video: "https://www.youtube.com/watch?v=LQVfMP-d0A8",
      image: "/exercises/neckstrain-scalene-stretch.svg",
    },
  ],
  shoulder: [
    {
      id: "shoulder-pendulum",
      ar: "تمرين البندول",
      en: "Pendulum",
      desc: "تحريك الذراع بحركة دائرية متدلّية لإرخاء المفصل.",
      video: "",
      image: "/exercises/shoulder-pendulum.svg",
    },
    {
      id: "shoulder-wall-walk",
      ar: "تسلّق الجدار بالأصابع",
      en: "Wall Finger Walk",
      desc: "تحريك الأصابع صعوداً على الجدار لزيادة المدى الحركي.",
      video: "",
      image: "/exercises/shoulder-wall-walk.svg",
    },
    {
      id: "shoulder-external-rotation",
      ar: "الدوران الخارجي بشريط المقاومة",
      en: "External Rotation",
      desc: "تدوير الساعد للخارج ضد مقاومة الشريط لتقوية الكفة المدوّرة.",
      video: "",
      image: "/exercises/shoulder-external-rotation.svg",
    },
    {
      id: "shoulder-cross-body",
      ar: "شدّ الكتف عبر الصدر",
      en: "Cross-Body Stretch",
      desc: "سحب الذراع عبر الصدر لإطالة الجزء الخلفي من الكتف.",
      video: "",
      image: "/exercises/shoulder-cross-body.svg",
    },
  ],
  knee: [
    {
      id: "knee-straight-leg-raise",
      ar: "رفع الساق المستقيمة",
      en: "Straight Leg Raise",
      desc: "رفع الساق مفرودة لتقوية العضلة الرباعية دون إجهاد المفصل.",
      video: "https://www.youtube.com/watch?v=vz04R3LnQwM",
      image: "/exercises/knee-straight-leg-raise.svg",
    },
    {
      id: "knee-quad-set",
      ar: "شدّ العضلة الرباعية الثابت",
      en: "Quad Set",
      desc: "شدّ عضلة الفخذ الأمامية مع الركبة مفرودة.",
      video: "https://www.youtube.com/watch?v=5TUK4uT2nnw",
      image: "/exercises/knee-quad-set.svg",
    },
    {
      id: "knee-mini-squat",
      ar: "نصف القرفصاء",
      en: "Mini Squat",
      desc: "ثني الركبتين جزئياً مع ثبات الجذع لتقوية الأطراف.",
      video: "https://www.youtube.com/watch?v=w2arL8LK_6E",
      image: "/exercises/knee-mini-squat.svg",
    },
    {
      id: "knee-hamstring-stretch",
      ar: "إطالة أوتار الركبة الخلفية",
      en: "Hamstring Stretch",
      desc: "مدّ الساق لإطالة العضلات الخلفية للفخذ.",
      video: "https://www.youtube.com/watch?v=QB8K_l17Q_I",
      image: "/exercises/knee-hamstring-stretch.svg",
    },
  ],
  ankle: [
    {
      id: "ankle-alphabet",
      ar: "تمرين الأبجدية بالكاحل",
      en: "Ankle Alphabet",
      desc: "رسم الحروف بالقدم لتحسين المدى الحركي في كل الاتجاهات.",
      video: "",
      image: "/exercises/ankle-alphabet.svg",
    },
    {
      id: "ankle-calf-raises",
      ar: "رفع الكعبين",
      en: "Calf Raises",
      desc: "الوقوف على أطراف الأصابع لتقوية عضلات الساق.",
      video: "",
      image: "/exercises/ankle-calf-raises.svg",
    },
    {
      id: "ankle-dorsiflexion",
      ar: "الثني الظهري بالمقاومة",
      en: "Dorsiflexion",
      desc: "سحب القدم للأعلى ضد شريط المقاومة لتقوية مقدّمة الساق.",
      video: "",
      image: "/exercises/ankle-dorsiflexion.svg",
    },
    {
      id: "ankle-achilles-stretch",
      ar: "إطالة وتر العرقوب",
      en: "Achilles Stretch",
      desc: "إطالة عضلة الساق والوتر مع ثبات الكعب على الأرض.",
      video: "",
      image: "/exercises/ankle-achilles-stretch.svg",
    },
  ],
  postop: [
    {
      id: "postop-passive-rom",
      ar: "تمارين المدى الحركي السلبي",
      en: "Passive ROM",
      desc: "تحريك المفصل بمساعدة خارجية ضمن المدى الآمن بعد الجراحة.",
      video: "",
      image: "/exercises/postop-passive-rom.svg",
    },
    {
      id: "postop-isometric",
      ar: "الشدّ العضلي الثابت",
      en: "Isometric Contractions",
      desc: "شدّ العضلة دون حركة المفصل للحفاظ على القوة.",
      video: "",
      image: "/exercises/postop-isometric.svg",
    },
    {
      id: "postop-gait",
      ar: "المشي المتدرّج",
      en: "Progressive Gait",
      desc: "تحميل وزن متدرّج على الطرف حسب توجيه المعالج.",
      video: "",
      image: "/exercises/postop-gait.svg",
    },
    {
      id: "postop-balance",
      ar: "تمارين التوازن",
      en: "Balance Training",
      desc: "تمارين ثبات للوقوف لاستعادة التحكّم الحركي.",
      video: "",
      image: "/exercises/postop-balance.svg",
    },
  ],
};

export const ALL_EXERCISES: LibraryExercise[] = Object.values(EX).flat();

export function exerciseById(id: string): LibraryExercise | undefined {
  return ALL_EXERCISES.find((ex) => ex.id === id);
}
