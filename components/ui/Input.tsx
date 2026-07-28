import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/cn";

export const controlClasses =
  "w-full rounded-field border-[1.5px] border-line bg-surface-2 px-[13px] py-[11px] transition-[border-color,background-color] duration-150 focus:border-brand focus:bg-surface focus:outline-none";

export function Input({
  className,
  ...props
}: ComponentPropsWithRef<"input">) {
  return <input className={cn(controlClasses, className)} {...props} />;
}
