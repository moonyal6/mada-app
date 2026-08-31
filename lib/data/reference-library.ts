import type { CaseKey } from "./cases";

/**
 * Pre-approved guidance summaries shown beside the plan step. Each entry is
 * doctor-reviewed content keyed by case; cases without an entry render the
 * "awaiting preparation" note. Verbatim from the clinic-system prototype —
 * only `back` is approved so far.
 */
export type ReferenceEntry = {
  summary: string[];
  refs: { source: string; url: string }[];
  status: string;
};

export const REFERENCE_LIBRARY: Partial<Record<CaseKey, ReferenceEntry>> = {
  back: {
    summary: [
      "طمأنة المريض وتوعيته بأن الحالة غالباً حميدة وتتحسّن تدريجياً.",
      "تشجيع الاستمرار في النشاط اليومي وتجنّب الراحة المطوّلة.",
      "برنامج تمارين مصمّم حسب قدرة المريض وتفضيله.",
      "تجنّب التصوير الإشعاعي الروتيني ما لم يغيّر الخطة.",
    ],
    refs: [
      { source: "NICE — آلام أسفل الظهر", url: "https://www.nice.org.uk/guidance/ng59" },
    ],
    status: "معتمد",
  },
};
