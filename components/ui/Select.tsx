import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/cn";
import { controlClasses } from "./Input";

export function Select({
  className,
  ...props
}: ComponentPropsWithRef<"select">) {
  return <select className={cn(controlClasses, className)} {...props} />;
}
