import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({
  title,
  sub,
  className,
  children,
}: {
  title?: string;
  sub?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mb-[18px] rounded-card border border-line bg-surface px-6 py-[22px] shadow-card-sm",
        className,
      )}
    >
      {title ? (
        <h3 className="mb-1 text-base font-semibold text-brand-dark">{title}</h3>
      ) : null}
      {sub ? <p className="mb-4 text-[13px] text-muted">{sub}</p> : null}
      {children}
    </div>
  );
}
