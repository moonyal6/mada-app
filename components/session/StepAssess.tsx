"use client";

import { useState } from "react";
import { apiSend } from "@/lib/api";
import { Icon } from "@/components/icons";
import { Spinner } from "@/components/ui/bits";
import { VoiceBox } from "./VoiceBox";
import type { ClinicalSession } from "@/lib/types";

type Suggestion = { assessment: string; impressions: string[] };

export function StepAssess({
  session,
  update,
  appendDialogue,
}: {
  session: ClinicalSession;
  update: (patch: Partial<ClinicalSession>) => void;
  appendDialogue: (text: string) => void;
}) {
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

  const suggest = async () => {
    setSuggesting(true);
    setSuggestError(null);
    setSuggestion(null);
    try {
      const result = await apiSend<Suggestion>(
        `/api/sessions/${session.id}/suggest`,
        "POST",
        { dialogue: session.dialogue },
      );
      setSuggestion(result);
      // Proposed impressions ride along to the plan step (and survive a
      // refresh) — as suggestions only, never as the diagnosis.
      if (result.impressions.length) {
        update({ suggestedDx: result.impressions });
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      setSuggestError(
        code === "empty_dialogue"
          ? "لا يوجد حوار بعد — سجّل أو اكتب أولاً."
          : "تعذّر توليد الاقتراح — حاول مجدداً.",
      );
    } finally {
      setSuggesting(false);
    }
  };

  const insertAssessment = () => {
    if (!suggestion) return;
    update({
      assessment: session.assessment.trim()
        ? session.assessment.trim() + "\n" + suggestion.assessment
        : suggestion.assessment,
    });
  };

  return (
    <div className="card">
      <h3>المساعد الصوتي</h3>
      <p className="sub">
        يحوّل حوار الجلسة إلى نص عربي ويقترح ملخّص التقييم. الاقتراح للمراجعة —
        القرار والصياغة لك.
      </p>
      <VoiceBox
        session={session}
        onConsented={(s) => update({ consentAt: s.consentAt })}
        onTranscript={appendDialogue}
      />
      <div className="field">
        <label>نص حوار الجلسة</label>
        <textarea
          className="tall"
          placeholder={"الطبيب: …\nالمريض: …"}
          value={session.dialogue}
          onChange={(e) => update({ dialogue: e.target.value })}
        />
      </div>
      <div className="field last">
        <label>
          ملخّص التقييم{" "}
          <span className="opt">يُقترح تلقائياً من الحوار أو يُكتب يدوياً</span>
        </label>
        <textarea
          placeholder="النتائج السريرية ذات الصلة…"
          value={session.assessment}
          onChange={(e) => update({ assessment: e.target.value })}
        />
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <button
            className="btn btn-soft btn-sm"
            onClick={suggest}
            disabled={suggesting || !session.dialogue.trim()}
          >
            <Icon name="sparkle" /> اقتراح ملخّص وانطباع من الحوار
          </button>
          {suggesting ? (
            <span className="status-line" style={{ margin: 0 }}>
              <Spinner /> جارٍ التحليل…
            </span>
          ) : null}
          {suggestError ? (
            <span className="status-line" style={{ margin: 0, color: "var(--danger)" }}>
              {suggestError}
            </span>
          ) : null}
        </div>
        {suggestion ? (
          <div className="reflib" style={{ marginTop: 10 }}>
            <h4>
              <Icon name="sparkle" size={14} /> اقتراح للمراجعة{" "}
              <span className="src-tag" style={{ marginInlineStart: 6 }}>
                مسودّة — القرار لك
              </span>
            </h4>
            {suggestion.assessment ? (
              <>
                <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>
                  {suggestion.assessment}
                </div>
                <button
                  className="btn btn-soft btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={insertAssessment}
                >
                  إدراج في ملخّص التقييم
                </button>
              </>
            ) : null}
            {suggestion.impressions.length ? (
              <div className="lnk" style={{ marginTop: 8 }}>
                الانطباعات المقترحة تظهر في خطوة «الخطة والتمارين» بجانب حقل
                التشخيص.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
