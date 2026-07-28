"use client";

import { useMemo, useState } from "react";
import { DirectGenerate } from "@/components/report/DirectGenerate";
import { GenerationModeToggle } from "@/components/report/GenerationModeToggle";
import { ManualPaste } from "@/components/report/ManualPaste";
import { PackagePreview } from "@/components/report/PackagePreview";
import { ReportDraft } from "@/components/report/ReportDraft";
import { Card } from "@/components/ui/Card";
import { StageHead } from "@/components/ui/StageHead";
import { useToast } from "@/components/ui/ToastProvider";
import { buildPackage } from "@/lib/buildPackage";
import { STAGE_ORDINALS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function ReportStage() {
  const { state, dispatch } = useSession();
  const toast = useToast();
  const [revealKey, setRevealKey] = useState(0);
  const pkg = useMemo(() => buildPackage(state), [state]);

  const showDraft = (text: string, sealed: boolean) => {
    dispatch({ type: "showDraft", text, sealed });
    setRevealKey((key) => key + 1);
  };

  const seal = () => {
    if (!state.report.trim()) {
      toast("لا يوجد نص تقرير للاعتماد");
      return;
    }
    dispatch({
      type: "seal",
      date: new Date().toLocaleDateString("ar-SA-u-ca-gregory", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    });
    setRevealKey((key) => key + 1);
    toast("اعتُمد التقرير بختم الطبيب");
  };

  return (
    <>
      <StageHead
        eyebrow={STAGE_ORDINALS[4]}
        title="توليد التقرير ومراجعته"
        description="تُجمع الحزمة كاملة وتُصاغ في تقرير سريري بالهيكل المعتمد. التقرير مسودّة حتى تعتمده بختمك."
      />
      <Card>
        <GenerationModeToggle />
        <h3 className="mb-1 text-base font-semibold text-brand-dark">
          حزمة الصياغة
        </h3>
        <p className="mb-4 text-[13px] text-muted">
          هذا ما يُرسَل للصياغة — بيانات المريض، الحالة، الحوار، رأيك، والتمارين.
        </p>
        <PackagePreview pkg={pkg} />

        {state.genMode === "direct" ? (
          <DirectGenerate pkg={pkg} onDraft={(text) => showDraft(text, false)} />
        ) : (
          <ManualPaste pkg={pkg} onDraft={(text) => showDraft(text, false)} />
        )}

        <ReportDraft
          revealKey={revealKey}
          onSeal={seal}
          onUnseal={() => showDraft(state.report, false)}
        />
      </Card>
    </>
  );
}
