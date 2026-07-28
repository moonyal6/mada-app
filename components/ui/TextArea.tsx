import type { ComponentPropsWithRef } from "react";
import { cn } from "@/lib/cn";
import { controlClasses } from "./Input";

export type TextAreaProps = ComponentPropsWithRef<"textarea"> & {
  /** The MVP's `.tall` modifier. */
  tall?: boolean;
};

export function TextArea({ className, tall, ...props }: TextAreaProps) {
  return (
    <textarea
      className={cn(
        controlClasses,
        "resize-y leading-[1.75]",
        tall ? "min-h-[190px]" : "min-h-[90px]",
        className,
      )}
      {...props}
    />
  );
}
