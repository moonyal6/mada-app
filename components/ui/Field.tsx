import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Field({
  label,
  optional,
  hint,
  last,
  className,
  children,
}: {
  label?: ReactNode;
  /** Rendered as the muted ".opt" suffix inside the label. */
  optional?: string;
  hint?: string;
  last?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5",
        last ? "mb-0" : "mb-[14px]",
        className,
      )}
    >
      {label ? (
        <label className="text-[13.5px] font-semibold text-ink">
          {label}
          {optional ? (
            <span className="text-xs font-normal text-muted"> {optional}</span>
          ) : null}
        </label>
      ) : null}
      {children}
      {hint ? <div className="text-xs text-muted">{hint}</div> : null}
    </div>
  );
}
