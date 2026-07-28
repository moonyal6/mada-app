"use client";

import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session-store";
import type { GenMode } from "@/lib/types";

const MODES: Array<{ mode: GenMode; label: string; dot: boolean }> = [
  { mode: "direct", label: "توليد مباشر عبر المنصّة", dot: true },
  { mode: "manual", label: "نسخ ولصق يدوي", dot: false },
];

export function GenerationModeToggle() {
  const { state, dispatch } = useSession();

  return (
    <div className="mb-[18px] inline-flex gap-[3px] rounded-field border-[1.5px] border-line bg-surface-2 p-[3px]">
      {MODES.map(({ mode, label, dot }) => (
        <button
          key={mode}
          type="button"
          onClick={() => dispatch({ type: "genMode", value: mode })}
          className={cn(
            "flex items-center gap-[7px] rounded-[7px] border-none px-4 py-[9px] text-[13.5px] font-medium",
            state.genMode === mode
              ? "bg-surface text-brand-dark shadow-card-sm"
              : "bg-transparent text-muted",
          )}
        >
          {dot ? (
            <span className="h-[7px] w-[7px] rounded-full bg-ok" />
          ) : null}{" "}
          {label}
        </button>
      ))}
    </div>
  );
}
