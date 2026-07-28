"use client";

import { useRef } from "react";
import { StorageNotice } from "@/components/layout/StorageNotice";
import { TopBar } from "@/components/layout/TopBar";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StageHead } from "@/components/ui/StageHead";
import { useToast } from "@/components/ui/ToastProvider";
import { toAr } from "@/lib/arabic";
import { CASES } from "@/lib/data/cases";
import { usePersistence } from "@/lib/persistence";
import type { SessionRecord } from "@/lib/storage";

const DATE_FMT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

function formatUpdated(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("ar-SA-u-ca-gregory", DATE_FMT);
}

function SessionRow({ record }: { record: SessionRecord }) {
  const { resume, newVisit } = usePersistence();
  const s = record.state;

  return (
    <div className="flex items-center gap-[14px] border-b border-line-2 py-[13px] last:border-b-0 max-[600px]:flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{s.patient.name || "بدون اسم"}</span>
          {s.sealed ? (
            <span className="rounded-full bg-gold-soft px-2 py-0.5 text-[10.5px] font-semibold text-gold-ink">
              معتمد
            </span>
          ) : (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-muted">
              مسودّة
            </span>
          )}
        </div>
        <div className="text-[12.5px] text-muted">
          {CASES[s.patient.caseKey].label} · {formatUpdated(record.updatedAt)}
        </div>
      </div>
      <Button variant="soft" size="sm" onClick={() => resume(record.id)}>
        استئناف
      </Button>
      <Button variant="ghost" size="sm" onClick={() => newVisit(record.id)}>
        زيارة جديدة
      </Button>
    </div>
  );
}

/** Entry view: saved sessions (most recent first), resume / new visit, and
 *  the JSON backup in and out. */
export function HomeScreen() {
  const { records, startNew, exportAll, importText } = usePersistence();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const onImportChange = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    let result: { added: number; updated: number } | null = null;
    try {
      result = importText(await file.text());
    } catch {
      result = null;
    }
    if (!result) {
      toast("تعذّر الاستيراد — الملف ليس نسخة احتياطية من مدى");
      return;
    }
    toast(
      `اكتمل الاستيراد: أُضيفت ${toAr(result.added)} وحُدّثت ${toAr(result.updated)}`,
    );
  };

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[820px] px-[34px] pt-[30px] pb-[60px] max-[900px]:px-[18px] max-[900px]:pt-[22px]">
        <StorageNotice />
        <section className="animate-rise">
          <StageHead
            eyebrow="جلسات العلاج الطبيعي"
            title="الجلسات المحفوظة"
            description="استأنف جلسة سابقة، أو ابدأ زيارة جديدة لمريض عائد تُنقل فيها بياناته وتشخيصه وتمارينه، أو افتح جلسة جديدة من الصفر. تُحفظ الجلسات تلقائياً في هذا المتصفح."
          />

          <div className="mb-[18px] flex flex-wrap items-center gap-2.5">
            <Button variant="primary" onClick={startNew}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>{" "}
              جلسة جديدة
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={exportAll}>
              تصدير البيانات (JSON)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileRef.current?.click()}
            >
              استيراد البيانات
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => onImportChange(e.currentTarget)}
            />
          </div>

          <Card>
            {records.length === 0 ? (
              <EmptyState className="p-6">
                لا توجد جلسات محفوظة بعد. ابدأ جلسة جديدة لتوثيق أول زيارة.
              </EmptyState>
            ) : (
              records.map((record) => (
                <SessionRow key={record.id} record={record} />
              ))
            )}
          </Card>

          <p className="text-xs text-muted">
            التصدير هو النسخة الاحتياطية الوحيدة — مسح بيانات المتصفح يمسح كل
            الجلسات المحفوظة.
          </p>
        </section>
      </main>
    </>
  );
}
