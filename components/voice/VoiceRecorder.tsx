"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Simulated transcription, kept exactly as in the MVP: a 700ms interval that
 * feeds canned dialogue lines into the session textarea and stops once the
 * script runs out.
 *
 * TODO: replace the interval with the real speech-to-text stream. The seam is
 * `onTranscript` — swap the timer for the transcription socket and leave the
 * rest of the component (labels, pulse, stop behaviour) untouched.
 */
const DEMO_LINES = [
  "الطبيب: السلام عليكم، تفضّل. وش اللي جابك اليوم؟",
  "المريض: عندي ألم في أسفل ظهري، صار له تقريباً شهر.",
  "الطبيب: بدأ فجأة ولا بالتدريج؟",
  "المريض: بالتدريج. أجلس على المكتب ساعات طويلة، ويزيد آخر اليوم.",
  "الطبيب: ينزل لرجلك ولا يبقى في الظهر؟",
  "المريض: غالباً في الظهر، بس أحياناً شدّ خفيف عند الورك. ما في تنميل.",
];

export function VoiceRecorder({
  onTranscript,
}: {
  onTranscript: (line: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const lineRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setRecording(false);
  };

  // Always clear the interval when the stage unmounts.
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const toggle = () => {
    if (recording) {
      stop();
      return;
    }
    setRecording(true);
    lineRef.current = 0;
    timer.current = setInterval(() => {
      if (lineRef.current >= DEMO_LINES.length) {
        stop();
        return;
      }
      onTranscriptRef.current(DEMO_LINES[lineRef.current]);
      lineRef.current += 1;
    }, 700);
  };

  return (
    <div className="mb-[14px] flex items-center gap-[14px] rounded-field border-[1.5px] border-dashed border-line bg-surface-2 px-4 py-[14px]">
      <button
        type="button"
        aria-label="بدء التسجيل"
        onClick={toggle}
        className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded-full border-none text-white",
          recording ? "animate-mic-pulse bg-danger" : "bg-brand",
        )}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-5 w-5"
        >
          <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
          <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4" />
        </svg>
      </button>
      <div className="flex-1 text-[13px] text-muted">
        <b className="block text-[13.5px] font-semibold text-ink">
          {recording ? "يسجّل ويفرّغ… (محاكاة)" : "اضغط لبدء التوثيق الصوتي"}
        </b>
        <span>{recording ? "اضغط للإيقاف" : "أو اكتب الحوار في الحقل أدناه"}</span>
      </div>
    </div>
  );
}
