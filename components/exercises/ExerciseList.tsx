import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** `.ex-list` */
export function ExerciseList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("grid gap-3", className)}>{children}</div>;
}
