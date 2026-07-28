"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/ToastProvider";
import { copyText } from "@/lib/clipboard";
import { useSession } from "@/lib/session-store";

type Status = "idle" | "busy" | "error" | "fallback";

const FALLBACK_NOTE =
  "الربط المباشر يعمل داخل بيئة كلود. للرفع على استضافة خارجية يلزم ربط خلفي بمفتاح API — استخدم الآن وضع «نسخ ولصق يدوي».";

export function DirectGenerate({
  pkg,
  onDraft,
}: {
  pkg: string;
  onDraft: (text: string) => void;
}) {
  const { dispatch } = useSession();
  const toast = useToast();
  const [status, setStatus] = useState<Status>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const generate = async () => {
    setStatus("busy");
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pkg }),
      });
      if (!res.ok) throw new Error("api " + res.status);
      const data: { text?: string } = await res.json();
      const text = (data.text ?? "").trim();
      if (!text) throw new Error("empty");
      setStatus("idle");
      onDraft(text);
    } catch {
      // Same recovery as the MVP: show the error, then hand the doctor the
      // copy/paste route after ~1.4s.
      setStatus("error");
      timer.current = setTimeout(() => {
        setStatus("fallback");
        dispatch({ type: "genMode", value: "manual" });
      }, 1400);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5">
        <Button variant="primary" disabled={status === "busy"} onClick={generate}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z" />
          </svg>{" "}
          توليد التقرير
        </Button>
        <Button
          variant="ghost"
          onClick={() => copyText(pkg, toast, "نُسخت الحزمة")}
        >
          نسخ الحزمة
        </Button>
      </div>
      {status === "idle" ? null : (
        <div className="my-4 flex items-center gap-2 text-[13px] text-muted">
          {status === "busy" ? (
            <>
              <Spinner /> جارٍ صياغة التقرير عبر كلود…
            </>
          ) : status === "error" ? (
            <span className="text-danger">
              تعذّر الربط المباشر بكلود في هذه البيئة.
            </span>
          ) : (
            FALLBACK_NOTE
          )}
        </div>
      )}
    </div>
  );
}
