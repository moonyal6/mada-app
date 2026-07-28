"use client";

import { Button } from "@/components/ui/Button";
import { STEPS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function ActionBar() {
  const { state, dispatch } = useSession();
  const isLast = state.step === STEPS.length - 1;

  return (
    <div className="actionbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/[0.9] backdrop-blur-[10px]">
      <div className="mx-auto flex max-w-[1240px] items-center gap-3 py-[13px] ps-[322px] pe-[34px] max-[900px]:py-3 max-[900px]:ps-[18px] max-[900px]:pe-[18px]">
        <Button
          variant="ghost"
          disabled={state.step === 0}
          onClick={() => dispatch({ type: "goto", step: state.step - 1 })}
        >
          السابق
        </Button>
        <div className="flex-1 text-[13px] text-muted">
          المرحلة <b className="text-brand-dark">{state.step + 1}</b> من{" "}
          {STEPS.length} · {STEPS[state.step].t}
        </div>
        <Button
          variant="primary"
          className={isLast ? "invisible" : undefined}
          onClick={() => dispatch({ type: "goto", step: state.step + 1 })}
        >
          التالي
        </Button>
      </div>
    </div>
  );
}
