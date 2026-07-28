"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/ToastProvider";
import { copyText } from "@/lib/clipboard";
import { controlClasses } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

/**
 * Paste-only field.
 *
 * `#pasteReport` is deliberately UNCONTROLLED and is never written to by the
 * application — no `value`, no `defaultValue`, no effect that sets it. The
 * doctor's authorship of the report has to be provable: anything the platform
 * could type into this box would blur the line between what the clinician
 * wrote and what a model produced. It is read exactly once, from the ref, when
 * "مراجعة التقرير الملصوق" is clicked.
 */
export function ManualPaste({
  pkg,
  onDraft,
}: {
  pkg: string;
  onDraft: (text: string) => void;
}) {
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  const load = () => {
    const text = pasteRef.current?.value.trim() ?? "";
    if (!text) {
      toast("الصق نص التقرير أولاً");
      return;
    }
    onDraft(text);
  };

  return (
    <div>
      <div className="mb-[14px] flex flex-wrap items-center gap-2.5">
        <Button
          variant="primary"
          onClick={() => copyText(pkg, toast, "نُسخت الحزمة")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>{" "}
          نسخ حزمة الصياغة
        </Button>
      </div>
      <p className="mb-4 text-[13px] text-muted">
        الصق الحزمة في محادثة كلود المخصّصة، ثم الصق نص التقرير الناتج هنا. هذا
        الحقل للّصق فقط ولا يُملأ تلقائياً.
      </p>
      <div>
        <textarea
          ref={pasteRef}
          placeholder="الصق نص التقرير هنا…"
          className={cn(
            controlClasses,
            "min-h-[200px] resize-y leading-[1.75]",
          )}
        />
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="h-3.5 w-3.5 text-brand"
          >
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>{" "}
          حقل لصق فقط — لا يُملأ تلقائياً، حفاظاً على تأليف الطبيب.
        </div>
        <Button variant="soft" className="mt-3" onClick={load}>
          مراجعة التقرير الملصوق
        </Button>
      </div>
    </div>
  );
}
