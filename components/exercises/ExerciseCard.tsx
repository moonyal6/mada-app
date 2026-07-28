import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Exercise } from "@/lib/types";

function ExerciseBody({ exercise }: { exercise: Exercise }) {
  return (
    <span className="flex-1">
      <span className="block text-start font-heading text-xs text-muted [direction:ltr]">
        {exercise.en}
      </span>
      <span className="block text-[15px] font-semibold text-ink">
        {exercise.ar}
      </span>
      <span className="mt-[3px] block text-[12.5px] text-muted">
        {exercise.desc}
      </span>
    </span>
  );
}

/**
 * `.ex` — used both for the selectable case library (checkbox + click to
 * toggle) and for AI suggestions (trailing action button).
 */
export function ExerciseCard({
  exercise,
  selected = false,
  onSelect,
  action,
  faded = false,
}: {
  exercise: Exercise;
  selected?: boolean;
  onSelect?: () => void;
  action?: ReactNode;
  faded?: boolean;
}) {
  const shell = cn(
    "rounded-field border-[1.5px] px-4 py-[14px] transition-all duration-150",
    selected ? "border-brand bg-brand-soft" : "border-line bg-surface",
    faded && "opacity-50",
  );

  if (onSelect) {
    return (
      <div className={shell}>
        <button
          type="button"
          onClick={onSelect}
          // leading-[1.7]: buttons are reset to line-height `normal` in
          // globals.css; this row is a layout container, so it keeps body copy.
          className="flex w-full items-start gap-[13px] leading-[1.7] text-start"
        >
          <span
            className={cn(
              "mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md border-2 transition-all duration-150",
              selected
                ? "border-brand bg-brand text-white"
                : "border-line bg-surface",
            )}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              className={cn(
                "h-[13px] w-[13px]",
                selected ? "opacity-100" : "opacity-0",
              )}
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </span>
          <ExerciseBody exercise={exercise} />
        </button>
      </div>
    );
  }

  return (
    <div className={shell}>
      <div className="flex items-start gap-[13px]">
        <ExerciseBody exercise={exercise} />
        {action ? <div className="shrink-0 self-center">{action}</div> : null}
      </div>
    </div>
  );
}
