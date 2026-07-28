import { HANDOUT_DAYS } from "@/lib/data/options";

/** `.ho-sched` — the weekly tick-box grid at the bottom of the handout. */
export function ComplianceGrid() {
  return (
    <div className="mt-[22px] rounded-[10px] bg-surface-2 p-4">
      <h4 className="mb-1 text-[15px] text-brand-dark">جدول الالتزام الأسبوعي</h4>
      <p className="mt-0.5 mb-3 text-[12.5px] text-muted">
        علّم عند إتمام تمارين اليوم.
      </p>
      <div className="grid grid-cols-7 gap-1.5">
        {HANDOUT_DAYS.map((day) => (
          <div
            key={day}
            className="rounded-[7px] border border-line bg-surface px-1 py-[9px] text-center text-xs"
          >
            <b className="mb-[5px] block font-semibold text-brand-dark">{day}</b>
            <div className="mx-auto h-[18px] w-[18px] rounded-[5px] border-[1.5px] border-line" />
          </div>
        ))}
      </div>
    </div>
  );
}
