import { cn } from "@/lib/cn";

/** The MVP's `.seg` control (ذكر / أنثى). */
export function Segmented({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="inline-flex gap-[3px] rounded-field border-[1.5px] border-line bg-surface-2 p-[3px]">
      {options.map((option) => {
        const on = option === value;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              "rounded-[7px] border-none px-5 py-2 text-sm font-medium",
              on ? "bg-brand text-white" : "bg-transparent text-muted",
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
