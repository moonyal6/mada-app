"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session-store";
import { ReportMarkdown } from "./ReportMarkdown";
import { SealBadge } from "./SealBadge";

type View = "preview" | "edit";

/** The writing step returns Markdown, so reading is the default view; the
 *  raw text stays one click away and is what gets copied and stored. */
function ViewToggle({
  view,
  onChange,
}: {
  view: View;
  onChange: (view: View) => void;
}) {
  return (
    <div className="inline-flex shrink-0 gap-[3px] rounded-[9px] border border-line bg-surface p-[3px]">
      {(
        [
          ["preview", "معاينة"],
          ["edit", "تحرير"],
        ] as const
      ).map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          className={cn(
            "rounded-[6px] border-none px-[11px] py-1 text-[12.5px] font-medium",
            view === value
              ? "bg-brand-soft text-brand-dark"
              : "bg-transparent text-muted",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ReportDraft({
  revealKey,
  onSeal,
  onUnseal,
}: {
  /** Bumped every time the draft is (re)shown, so it scrolls into view. */
  revealKey: number;
  onSeal: () => void;
  onUnseal: () => void;
}) {
  const { state, dispatch } = useSession();
  const toast = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>("preview");

  useEffect(() => {
    if (revealKey > 0)
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [revealKey]);

  if (!state.draftVisible) return null;

  return (
    <div
      ref={rootRef}
      className="mt-[18px] overflow-hidden rounded-card border-[1.5px] border-gold-line"
    >
      <div
        className={cn(
          "flex items-center gap-[9px] border-b px-4 py-[11px] text-[13px] font-semibold",
          state.sealed
            ? "border-brand-soft bg-brand-soft text-brand-dark"
            : "border-gold-line bg-gold-soft text-gold-ink",
        )}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
        <span>
          {state.sealed
            ? "التقرير معتمد بختم الطبيب."
            : "مسودّة التقرير — بانتظار مراجعتك واعتمادك. لك مطلق الحرية في التعديل."}
        </span>
        <div className="flex-1" />
        <ViewToggle view={view} onChange={setView} />
      </div>

      {view === "preview" ? (
        <ReportMarkdown
          text={state.report}
          className={cn(
            "min-h-[340px]",
            state.sealed ? "bg-surface-2" : "bg-surface",
          )}
        />
      ) : (
        <textarea
          spellCheck={false}
          readOnly={state.sealed}
          value={state.report}
          onChange={(e) =>
            dispatch({ type: "reportText", value: e.target.value })
          }
          className={cn(
            "block w-full min-h-[340px] resize-y rounded-none border-none px-[22px] py-5 text-[14.5px] leading-[1.9] focus:outline-none",
            state.sealed ? "bg-surface-2" : "bg-surface",
          )}
        />
      )}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-line-2 bg-surface-2 px-4 py-3">
        {state.sealed ? null : (
          <Button variant="gold" onClick={onSeal}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 12l2 2 4-4" />
              <circle cx="12" cy="12" r="9" />
            </svg>{" "}
            اعتماد التقرير بختم الطبيب
          </Button>
        )}
        {state.sealed ? <SealBadge date={state.sealDate} /> : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          onClick={() => copyText(state.report, toast, "نُسخ التقرير")}
        >
          نسخ التقرير
        </Button>
        {state.sealed ? (
          <Button
            variant="ghost"
            onClick={() => {
              // "…للتعديل" — land them in the editor, not the reading view.
              setView("edit");
              onUnseal();
            }}
          >
            إلغاء الاعتماد للتعديل
          </Button>
        ) : null}
      </div>
    </div>
  );
}
