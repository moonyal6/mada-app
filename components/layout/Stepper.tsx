"use client";

import { cn } from "@/lib/cn";
import { STEPS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";
import { SideNote } from "./SideNote";

export function Stepper() {
  const { state, dispatch } = useSession();

  return (
    <aside className="side sticky top-[63px] h-[calc(100vh-63px)] overflow-auto border-s border-line px-5 py-[26px] max-[900px]:hidden">
      <p className="m-0 mb-4 me-1 text-xs font-semibold tracking-[0.06em] text-muted uppercase">
        جلسة علاج طبيعي
      </p>
      <ul className="relative m-0 list-none p-0 before:absolute before:top-[14px] before:bottom-[14px] before:start-[19px] before:w-[2px] before:bg-line-2 before:content-['']">
        {STEPS.map((step, i) => {
          const active = i === state.step;
          const done = i < state.step;
          return (
            <li key={step.t} className="relative">
              <button
                type="button"
                onClick={() => dispatch({ type: "goto", step: i })}
                className={cn(
                  // leading-[1.7] restores the body line-height inside a
                  // <button> (buttons are reset to `normal` in globals.css).
                  "mb-[2px] flex w-full items-start gap-[13px] rounded-[11px] px-1.5 py-[9px] leading-[1.7] text-start transition-colors duration-150",
                  active ? "bg-brand-soft" : "hover:bg-surface-2",
                )}
              >
                <span
                  className={cn(
                    "z-[1] grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 font-semibold transition-all duration-[180ms]",
                    active && "border-brand bg-brand text-white",
                    done && "border-brand bg-surface text-brand",
                    !active && !done && "border-line bg-surface text-muted",
                    done ? "text-[15px]" : "text-[14px]",
                  )}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span className="pt-2">
                  <b className="block text-[14.5px] leading-[1.3] font-semibold text-ink">
                    {step.t}
                  </b>
                  <span className="text-xs text-muted">{step.s}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <SideNote />
    </aside>
  );
}
