import { cn } from "@/lib/cn";
import { ArcIcon } from "./ArcIcon";

export function StageHead({
  eyebrow,
  title,
  description,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-[22px]", className)}>
      <div className="mb-[7px] flex items-center gap-[9px] text-[12.5px] font-semibold text-brand">
        <ArcIcon /> {eyebrow}
      </div>
      <h2 className="m-0 text-[27px] font-semibold tracking-[-0.6px] text-brand-dark">
        {title}
      </h2>
      <p className="mt-[7px] mb-0 max-w-[62ch] text-[14.5px] text-muted">
        {description}
      </p>
    </div>
  );
}
