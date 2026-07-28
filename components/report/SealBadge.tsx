import { DOCTOR } from "@/lib/config";

export function SealBadge({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-[9px] text-[13px] text-brand-dark">
      <span className="grid h-[34px] w-[34px] place-items-center rounded-full border-[1.5px] border-gold bg-gold-soft text-[15px] text-gold">
        ✓
      </span>
      <div>
        <b>معتمد</b> — {DOCTOR.name} · <span>{date}</span>
      </div>
    </div>
  );
}
