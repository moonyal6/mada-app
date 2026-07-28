import { BRAND, DOCTOR } from "@/lib/config";
import { BrandMark } from "@/components/ui/BrandMark";

export function TopBar() {
  return (
    <header className="topbar sticky top-0 z-40 flex items-center gap-[14px] border-b border-line bg-surface/[0.82] px-[22px] py-3 backdrop-blur-[10px]">
      <div className="flex items-center gap-[11px]">
        <BrandMark className="h-[38px] w-[38px]" />
        <div className="text-[23px] font-bold tracking-[-0.5px] text-brand-dark">
          {BRAND.name}{" "}
          <small className="ms-[2px] text-[12.5px] font-normal tracking-normal text-muted">
            {BRAND.nameNote}
          </small>
        </div>
        <div className="ms-1 border-s border-line ps-3 text-[12.5px] text-muted max-[900px]:hidden">
          {BRAND.tagline}
        </div>
      </div>
      <div className="flex-1" />
      <span className="rounded-full border border-gold-line bg-gold-soft px-[11px] py-[5px] text-xs font-semibold text-gold-ink">
        {BRAND.badge}
      </span>
      <div className="flex items-center gap-[9px] text-[13px] text-muted">
        <span>{DOCTOR.name}</span>
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-soft text-[13px] font-semibold text-brand-dark">
          {DOCTOR.initials}
        </span>
      </div>
    </header>
  );
}
