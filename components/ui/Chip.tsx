import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ChipMode = "select" | "insert" | "num";

/**
 * `.chip-btn` in the MVP.
 *  - select : toggles a value on/off
 *  - num    : narrow, centred variant used by the 0–10 pain scale
 *  - insert : dashed "＋" chip that appends its text into a textarea
 */
export function Chip({
  mode = "select",
  on = false,
  onClick,
  children,
}: {
  mode?: ChipMode;
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border-[1.5px] text-[13px] font-medium transition-all duration-[130ms]",
        mode === "num"
          ? "min-w-9 px-2 py-1.5 text-center"
          : "px-[13px] py-1.5",
        mode === "insert" && "border-dashed font-normal",
        on
          ? "border-brand bg-brand text-white"
          : "border-line bg-surface-2 text-ink hover:border-brand hover:text-brand",
      )}
    >
      {mode === "insert" ? <span className="opacity-60">{"＋ "}</span> : null}
      {children}
    </button>
  );
}
