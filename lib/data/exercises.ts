import type { CaseKey } from "./cases";
import type { Exercise } from "../types";

/**
 * The exercise library. `video` is the URL the handout QR encodes — the
 * library structure ships first and the URLs arrive separately as content.
 * While a video is empty, the basket and the printed handout show a clear
 * "no video" placeholder instead of a QR that scans into nothing.
 */
export const EX: Record<CaseKey, Exercise[]> = {
  back: [
    {
      ar: "إمالة الحوض",
      en: "Pelvic Tilt",
      desc: "شدّ لطيف لعضلات البطن مع تسطيح أسفل الظهر على الأرض.",
      video: "",
    },
    {
      ar: "القطة والبقرة",
      en: "Cat–Cow",
      desc: "تبديل بين تقويس الظهر وتحديبه لتحسين مرونة العمود الفقري.",
      video: "",
    },
    {
      ar: "تمرين الجسر",
      en: "Bridging",
      desc: "رفع الحوض مع ثبات القدمين لتقوية الألوية وأسفل الظهر.",
      video: "",
    },
    {
      ar: "شدّ الركبة للصدر",
      en: "Knee-to-Chest",
      desc: "تقريب الركبة نحو الصدر لإطالة عضلات أسفل الظهر.",
      video: "",
    },
    {
      ar: "الطائر والكلب",
      en: "Bird-Dog",
      desc: "مدّ ذراع وساق متقابلتين مع ثبات الجذع لتحسين الاتزان.",
      video: "",
    },
  ],
  neck: [
    {
      ar: "شدّ الذقن (الانكماش العنقي)",
      en: "Chin Tuck",
      desc: "سحب الذقن للخلف لمحاذاة الرأس فوق الكتفين.",
      video: "",
    },
    {
      ar: "الإمالة الجانبية للرقبة",
      en: "Lateral Neck Flexion",
      desc: "إمالة الرأس نحو الكتف لإطالة الجانب المقابل.",
      video: "",
    },
    {
      ar: "دوران الرقبة",
      en: "Neck Rotation",
      desc: "إدارة الرأس ببطء يميناً ويساراً ضمن المدى المريح.",
      video: "",
    },
    {
      ar: "إطالة العضلة شبه المنحرفة العلوية",
      en: "Upper Trapezius Stretch",
      desc: "إمالة الرأس مع سحب لطيف لإرخاء أعلى الكتف.",
      video: "",
    },
  ],
  neckstrain: [
    {
      ar: "إطالة العضلة شبه المنحرفة العلوية",
      en: "Upper Trapezius Stretch",
      desc: "إمالة الرأس نحو الجانب مع سحب لطيف لإرخاء أعلى الكتف.",
      video: "",
    },
    {
      ar: "إطالة العضلة الرافعة للكتف",
      en: "Levator Scapulae Stretch",
      desc: "إدارة الرأس للأسفل جانبياً لإطالة العضلة الرافعة للكتف.",
      video: "",
    },
    {
      ar: "لفّ الكتفين للخلف",
      en: "Shoulder Rolls",
      desc: "تدوير الكتفين للخلف لإرخاء التوتر العضلي أعلى الظهر.",
      video: "",
    },
    {
      ar: "شدّ الذقن (الانكماش العنقي)",
      en: "Chin Tuck",
      desc: "سحب الذقن للخلف لتصحيح وضع الرأس وتخفيف الحمل العضلي.",
      video: "",
    },
    {
      ar: "إطالة العضلات الأخمعية",
      en: "Scalene Stretch",
      desc: "إمالة الرأس مع تثبيت الترقوة لإطالة جانب الرقبة الأمامي.",
      video: "",
    },
  ],
  shoulder: [
    {
      ar: "تمرين البندول",
      en: "Pendulum",
      desc: "تحريك الذراع بحركة دائرية متدلّية لإرخاء المفصل.",
      video: "",
    },
    {
      ar: "تسلّق الجدار بالأصابع",
      en: "Wall Finger Walk",
      desc: "تحريك الأصابع صعوداً على الجدار لزيادة المدى الحركي.",
      video: "",
    },
    {
      ar: "الدوران الخارجي بشريط المقاومة",
      en: "External Rotation",
      desc: "تدوير الساعد للخارج ضد مقاومة الشريط لتقوية الكفة المدوّرة.",
      video: "",
    },
    {
      ar: "شدّ الكتف عبر الصدر",
      en: "Cross-Body Stretch",
      desc: "سحب الذراع عبر الصدر لإطالة الجزء الخلفي من الكتف.",
      video: "",
    },
  ],
  knee: [
    {
      ar: "رفع الساق المستقيمة",
      en: "Straight Leg Raise",
      desc: "رفع الساق مفرودة لتقوية العضلة الرباعية دون إجهاد المفصل.",
      video: "",
    },
    {
      ar: "شدّ العضلة الرباعية الثابت",
      en: "Quad Set",
      desc: "شدّ عضلة الفخذ الأمامية مع الركبة مفرودة.",
      video: "",
    },
    {
      ar: "نصف القرفصاء",
      en: "Mini Squat",
      desc: "ثني الركبتين جزئياً مع ثبات الجذع لتقوية الأطراف.",
      video: "",
    },
    {
      ar: "إطالة أوتار الركبة الخلفية",
      en: "Hamstring Stretch",
      desc: "مدّ الساق لإطالة العضلات الخلفية للفخذ.",
      video: "",
    },
  ],
  ankle: [
    {
      ar: "تمرين الأبجدية بالكاحل",
      en: "Ankle Alphabet",
      desc: "رسم الحروف بالقدم لتحسين المدى الحركي في كل الاتجاهات.",
      video: "",
    },
    {
      ar: "رفع الكعبين",
      en: "Calf Raises",
      desc: "الوقوف على أطراف الأصابع لتقوية عضلات الساق.",
      video: "",
    },
    {
      ar: "الثني الظهري بالمقاومة",
      en: "Dorsiflexion",
      desc: "سحب القدم للأعلى ضد شريط المقاومة لتقوية مقدّمة الساق.",
      video: "",
    },
    {
      ar: "إطالة وتر العرقوب",
      en: "Achilles Stretch",
      desc: "إطالة عضلة الساق والوتر مع ثبات الكعب على الأرض.",
      video: "",
    },
  ],
  postop: [
    {
      ar: "تمارين المدى الحركي السلبي",
      en: "Passive ROM",
      desc: "تحريك المفصل بمساعدة خارجية ضمن المدى الآمن بعد الجراحة.",
      video: "",
    },
    {
      ar: "الشدّ العضلي الثابت",
      en: "Isometric Contractions",
      desc: "شدّ العضلة دون حركة المفصل للحفاظ على القوة.",
      video: "",
    },
    {
      ar: "المشي المتدرّج",
      en: "Progressive Gait",
      desc: "تحميل وزن متدرّج على الطرف حسب توجيه المعالج.",
      video: "",
    },
    {
      ar: "تمارين التوازن",
      en: "Balance Training",
      desc: "تمارين ثبات للوقوف لاستعادة التحكّم الحركي.",
      video: "",
    },
  ],
};
