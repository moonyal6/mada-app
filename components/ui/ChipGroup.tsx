import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** `.chips` — the flex-wrap row every chip set sits in. */
export function ChipGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mt-[2px] flex flex-wrap gap-[7px]", className)}>
      {children}
    </div>
  );
}

/** `.chips-label` — the small caption above an insert-chip row. */
export function ChipGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 mb-[5px] text-[11.5px] text-muted">{children}</div>
  );
}
