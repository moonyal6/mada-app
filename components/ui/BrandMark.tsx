import { cn } from "@/lib/cn";

/** The مدى mark. Colours come from the theme (fill-brand-soft / stroke-brand /
 *  stroke-gold), so the logo tracks the design tokens like everything else. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className={cn("shrink-0", className)}
    >
      <circle cx="20" cy="20" r="19" className="fill-brand-soft" />
      <path
        d="M7 27 A13 13 0 0 1 33 27"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
        className="stroke-brand"
      />
      <path
        d="M20 27 L28.5 15.5"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="stroke-gold"
      />
      <circle cx="20" cy="27" r="2.6" className="fill-brand" />
    </svg>
  );
}
