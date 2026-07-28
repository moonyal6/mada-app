"use client";

import { Handout } from "@/components/handout/Handout";
import { Button } from "@/components/ui/Button";
import { StageHead } from "@/components/ui/StageHead";
import { useToast } from "@/components/ui/ToastProvider";
import { STAGE_ORDINALS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function HandoutStage() {
  const { state } = useSession();
  const toast = useToast();
  const hasExercises = Object.keys(state.selected).length > 0;

  return (
    <>
      {/* Hidden in print, exactly like the MVP — the printed page is the
          handout card and nothing else. */}
      <StageHead
        className="no-print"
        eyebrow={STAGE_ORDINALS[5]}
        title="نشرة المريض"
        description="نشرة جاهزة للطباعة أو الإرسال — تمارين البرنامج المنزلي بأكواد QR، وجدول التزام أسبوعي."
      />
      <div className="no-print mb-[18px] flex flex-wrap items-center gap-2.5 rounded-card border border-line bg-surface px-6 py-[22px] shadow-card-sm">
        <Button
          variant="primary"
          onClick={() => {
            if (!hasExercises) {
              toast("اختر تمارين أولاً");
              return;
            }
            window.print();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z" />
          </svg>{" "}
          طباعة / حفظ PDF
        </Button>
        <span className="text-xs text-muted">
          النشرة تُبنى تلقائياً من سلّة التمارين المختارة.
        </span>
      </div>
      <Handout />
    </>
  );
}
