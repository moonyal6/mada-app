import { cn } from "@/lib/cn";

/**
 * Placeholder shown wherever an exercise QR would render but the exercise has
 * no video URL yet — in the basket and on the printed handout. A QR that
 * scans into nothing is worse than saying so.
 */
export function NoVideoTile({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-lg border-[1.5px] border-dashed border-line bg-surface-2",
        className,
      )}
    >
      <div className="px-1 text-center text-[10px] leading-[1.4] font-medium text-muted">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="mx-auto mb-0.5 h-4 w-4"
        >
          <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
          <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10z" />
          <path d="M2 2l20 20" />
        </svg>
        بدون فيديو
      </div>
    </div>
  );
}
