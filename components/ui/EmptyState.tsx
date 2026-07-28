import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({
  icon,
  className,
  children,
}: {
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "p-10 text-center text-sm text-muted [&>svg]:mb-2.5 [&>svg]:h-10 [&>svg]:w-10 [&>svg]:text-line",
        className,
      )}
    >
      {icon}
      {children}
    </div>
  );
}
