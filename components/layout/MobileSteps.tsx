"use client";

import { cn } from "@/lib/cn";
import { STEPS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function MobileSteps() {
  const { state, dispatch } = useSession();

  return (
    <nav className="mobile-steps sticky top-[63px] z-20 hidden gap-1.5 overflow-auto border-b border-line bg-surface px-[18px] py-2.5 max-[900px]:flex">
      {STEPS.map((step, i) => (
        <button
          key={step.t}
          type="button"
          onClick={() => dispatch({ type: "goto", step: i })}
          className={cn(
            "shrink-0 rounded-full border-[1.5px] px-[13px] py-1.5 text-[12.5px] font-medium",
            i === state.step
              ? "border-brand bg-brand text-white"
              : "border-line bg-surface text-muted",
          )}
        >
          {i + 1}. {step.t}
        </button>
      ))}
    </nav>
  );
}
