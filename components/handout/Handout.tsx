"use client";

import { BrandMark } from "@/components/ui/BrandMark";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { BRAND, DOCTOR } from "@/lib/config";
import { CASES } from "@/lib/data/cases";
import { useSession } from "@/lib/session-store";
import { ComplianceGrid } from "./ComplianceGrid";
import { HandoutExerciseRow } from "./HandoutExerciseRow";

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
};

/** Matches the MVP's `&nbsp;·&nbsp;` separator in the patient line. */
const SEP = " · ";

export function Handout() {
  const { state } = useSession();
  const exercises = Object.values(state.selected);
  const p = state.patient;

  if (exercises.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6" />
            </svg>
          }
        >
          <div>لم تُختر تمارين بعد. ارجع للمرحلة الرابعة لاختيار التمارين.</div>
        </EmptyState>
      </Card>
    );
  }

  const dateFmt = (
    state.doctor.date ? new Date(state.doctor.date) : new Date()
  ).toLocaleDateString("ar-SA-u-ca-gregory", DATE_FORMAT);

  return (
    <div className="handout overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-start justify-between border-b-2 border-brand px-7 py-6">
        <div className="flex items-center gap-2.5">
          <BrandMark className="h-[34px] w-[34px]" />
          <div className="font-heading text-[22px] font-bold text-brand-dark">
            {BRAND.name}
          </div>
        </div>
        <div className="text-end text-[12.5px] leading-[1.7] text-muted">
          {BRAND.handoutTitle}
          <br />
          {DOCTOR.name} · {DOCTOR.specialty}
          <br />
          {dateFmt}
        </div>
      </div>

      <div className="px-7 py-6">
        <div className="mb-5 border-b border-line-2 pb-4 text-[13.5px] text-muted">
          <b>المريض:</b> {p.name || "—"}
          {SEP}
          <b>الحالة:</b> {CASES[p.caseKey].label}
          {p.age ? (
            <>
              {SEP}
              <b>العمر:</b> {p.age}
            </>
          ) : null}
        </div>

        <h4 className="mb-1 text-[15px] text-brand-dark">تمارينك اليومية</h4>
        <p className="mt-1 mb-3 text-[13px] text-muted">
          امسح رمز QR لمشاهدة فيديو كل تمرين.
        </p>

        <div>
          {exercises.map((exercise, i) => (
            <HandoutExerciseRow
              key={`${exercise.ar}-${i}`}
              index={i}
              exercise={exercise}
            />
          ))}
        </div>

        <ComplianceGrid />
      </div>

      <div className="border-t border-line-2 bg-surface-2 px-7 py-4 text-center text-xs text-muted">
        هذه النشرة أداة مساعدة ضمن خطة علاجك — التزم بها بين الجلسات، وراجع
        معالجك عند أي ألم غير معتاد.
      </div>
    </div>
  );
}
