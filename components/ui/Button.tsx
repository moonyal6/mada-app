import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "gold" | "ghost" | "soft";
type Size = "md" | "sm";

const VARIANTS: Record<Variant, string> = {
  primary: "border-transparent bg-brand text-white hover:bg-brand-hover",
  gold: "border-transparent bg-gold text-white hover:bg-gold-hover",
  ghost: "border-line bg-surface text-ink hover:border-brand hover:text-brand",
  soft: "border-transparent bg-brand-soft text-brand-dark hover:bg-brand-soft-hover",
};

const SIZES: Record<Size, string> = {
  md: "px-5 py-[11px] text-[14.5px]",
  sm: "px-[14px] py-2 text-[13px]",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-field border-[1.5px] font-semibold transition-all duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "[&_svg]:h-[17px] [&_svg]:w-[17px]",
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
