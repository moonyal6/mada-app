import { cn } from "@/lib/cn";

export function Toast({ message, show }: { message: string; show: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        // no-print: a toast that happens to be on screen must not end up on
        // the printed patient handout.
        "no-print fixed bottom-20 start-1/2 z-[100] translate-x-1/2 rounded-full bg-brand-dark px-5 py-[11px] text-[13.5px] font-medium text-white shadow-card transition-all duration-[250ms]",
        show
          ? "-translate-y-1.5 opacity-100"
          : "pointer-events-none opacity-0",
      )}
    >
      {message}
    </div>
  );
}
