"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { VOICE_SIMULATION } from "@/lib/config";

/**
 * The mic. Same shell as the MVP (button, pulse, two-line label) — only the
 * engine changed: the browser's Web Speech API (webkitSpeechRecognition,
 * lang ar-SA), continuous with interim results.
 *
 * - Finished phrases go out through `onFinal` and get appended to the
 *   dialogue; the in-flight phrase streams through `onInterim` and is shown
 *   live but not yet committed.
 * - Audio is never stored — recognition streams from the mic and only text
 *   ever touches state.
 * - Every failure (unsupported browser, denied permission, recognition error)
 *   lands in a labelled state that points back to typing, which keeps working
 *   throughout.
 * - Chromium ends continuous recognition after silence (~8s, error
 *   "no-speech") and periodically on its own; while the doctor hasn't pressed
 *   stop, benign ends restart the engine so one tap spans the whole session.
 * - VOICE_SIMULATION in lib/config.ts brings back the MVP's scripted demo
 *   lines if real recognition proves unusable.
 */

/* Web Speech is not in TS's lib.dom; the ambient surface we need is small. */
interface RecognitionAlternativeLike {
  transcript: string;
}
interface RecognitionResultLike {
  isFinal: boolean;
  0: RecognitionAlternativeLike;
}
interface RecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResultLike };
}
interface RecognitionErrorEventLike {
  error: string;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onaudiostart: (() => void) | null;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function getRecognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ??
    w.webkitSpeechRecognition ??
    null) as RecognitionCtor | null;
}

/** Give up restarting when recognition dies this many times in under a
 *  second with no results — a mic or engine problem, not silence. */
const MAX_RAPID_ENDS = 5;

/** A started engine that emits no event at all for this long is dead — e.g.
 *  a Chromium build without a speech service, or a permission prompt left
 *  unanswered. A live engine always says something well before this (Chrome
 *  fires "no-speech" after ~8s of silence), so a quiet room can't trip it. */
const DEAD_ENGINE_MS = 15000;

const DEMO_LINES = [
  "الطبيب: السلام عليكم، تفضّل. وش اللي جابك اليوم؟",
  "المريض: عندي ألم في أسفل ظهري، صار له تقريباً شهر.",
  "الطبيب: بدأ فجأة ولا بالتدريج؟",
  "المريض: بالتدريج. أجلس على المكتب ساعات طويلة، ويزيد آخر اليوم.",
  "الطبيب: ينزل لرجلك ولا يبقى في الظهر؟",
  "المريض: غالباً في الظهر، بس أحياناً شدّ خفيف عند الورك. ما في تنميل.",
];

type EngineState = "idle" | "recording" | "unsupported" | "denied" | "error";

const LABELS: Record<EngineState, { title: string; hint: string }> = {
  idle: {
    title: "اضغط لبدء التوثيق الصوتي",
    hint: "أو اكتب الحوار في الحقل أدناه",
  },
  recording: {
    title: VOICE_SIMULATION ? "يسجّل ويفرّغ… (محاكاة)" : "يسجّل ويفرّغ…",
    hint: "اضغط للإيقاف",
  },
  unsupported: {
    title: "التعرّف الصوتي غير مدعوم في هذا المتصفح",
    hint: "اكتب الحوار في الحقل أدناه — الكتابة متاحة دائماً",
  },
  denied: {
    title: "لم يُسمح باستخدام الميكروفون",
    hint: "فعّل إذن الميكروفون من إعدادات المتصفح، أو اكتب الحوار في الحقل أدناه",
  },
  error: {
    title: "تعذّر التفريغ الصوتي",
    hint: "اضغط للمحاولة مجدداً، أو اكتب الحوار في الحقل أدناه",
  },
};

export function VoiceRecorder({
  onFinal,
  onInterim,
}: {
  /** A finished phrase — append it to the dialogue. */
  onFinal: (line: string) => void;
  /** The in-flight phrase ("" clears it) — display only, not yet committed. */
  onInterim: (text: string) => void;
}) {
  // Support check in the initializer is safe: this component only renders
  // behind the persistence `ready` gate, i.e. client-side after mount.
  const [engine, setEngine] = useState<EngineState>(() =>
    !VOICE_SIMULATION && !getRecognitionCtor() ? "unsupported" : "idle",
  );

  const recRef = useRef<RecognitionLike | null>(null);
  /** True from press-to-start until press-to-stop (or a fatal error). */
  const activeRef = useRef(false);
  const fatalRef = useRef(false);
  const interimRef = useRef("");
  const lastStartRef = useRef(0);
  const rapidEndsRef = useRef(0);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const simTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simLineRef = useRef(0);

  const onFinalRef = useRef(onFinal);
  const onInterimRef = useRef(onInterim);
  useEffect(() => {
    onFinalRef.current = onFinal;
    onInterimRef.current = onInterim;
  }, [onFinal, onInterim]);

  // Leaving the stage mid-recording: commit the in-flight phrase so no words
  // are lost, then tear the engine down without callbacks.
  useEffect(
    () => () => {
      activeRef.current = false;
      fatalRef.current = true;
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      const rec = recRef.current;
      if (rec) {
        rec.onaudiostart = null;
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        if (interimRef.current) onFinalRef.current(interimRef.current);
        interimRef.current = "";
        try {
          rec.abort();
        } catch {
          // Already stopped.
        }
        recRef.current = null;
      }
      if (simTimerRef.current) clearInterval(simTimerRef.current);
    },
    [],
  );

  const startRecognition = () => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setEngine("unsupported");
      return;
    }
    const rec = new Ctor();
    rec.lang = "ar-SA";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    // Any sign of life disarms the dead-engine watchdog until the next
    // (re)start.
    const disarmWatchdog = () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    };
    const armWatchdog = () => {
      disarmWatchdog();
      watchdogRef.current = setTimeout(() => {
        fatalRef.current = true;
        setEngine("error");
        try {
          rec.abort();
        } catch {
          // Nothing left to abort.
        }
      }, DEAD_ENGINE_MS);
    };

    rec.onaudiostart = disarmWatchdog;

    rec.onresult = (event) => {
      disarmWatchdog();
      rapidEndsRef.current = 0;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const line = text.trim();
          if (line) onFinalRef.current(line);
        } else {
          interim += text;
        }
      }
      interimRef.current = interim.trim();
      onInterimRef.current(interimRef.current);
    };

    rec.onerror = (event) => {
      disarmWatchdog();
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        fatalRef.current = true;
        setEngine("denied");
      } else if (event.error === "audio-capture" || event.error === "network") {
        fatalRef.current = true;
        setEngine("error");
      }
      // "no-speech" and "aborted" are routine; onend decides what happens.
    };

    rec.onend = () => {
      disarmWatchdog();
      // Whatever never finalized would be dropped by the engine — keep it.
      const leftover = interimRef.current;
      interimRef.current = "";
      onInterimRef.current("");
      if (leftover) onFinalRef.current(leftover);

      if (activeRef.current && !fatalRef.current) {
        const rapid = Date.now() - lastStartRef.current < 1000;
        rapidEndsRef.current = rapid ? rapidEndsRef.current + 1 : 0;
        if (rapidEndsRef.current < MAX_RAPID_ENDS) {
          try {
            lastStartRef.current = Date.now();
            rec.start();
            armWatchdog();
            return;
          } catch {
            // Engine refused the restart; fall through to a visible stop.
          }
        }
        setEngine("error");
      } else {
        setEngine((prev) => (prev === "recording" ? "idle" : prev));
      }
      activeRef.current = false;
      recRef.current = null;
    };

    fatalRef.current = false;
    activeRef.current = true;
    rapidEndsRef.current = 0;
    interimRef.current = "";
    recRef.current = rec;
    try {
      lastStartRef.current = Date.now();
      rec.start();
      armWatchdog();
      setEngine("recording");
    } catch {
      disarmWatchdog();
      activeRef.current = false;
      recRef.current = null;
      setEngine("error");
    }
  };

  const stopRecognition = () => {
    activeRef.current = false;
    // stop() (not abort) lets the engine finalize the phrase in flight;
    // onend commits whatever is left and returns the UI to idle.
    try {
      recRef.current?.stop();
    } catch {
      setEngine("idle");
    }
  };

  const toggleSimulation = () => {
    if (simTimerRef.current) {
      clearInterval(simTimerRef.current);
      simTimerRef.current = null;
      setEngine("idle");
      return;
    }
    simLineRef.current = 0;
    setEngine("recording");
    simTimerRef.current = setInterval(() => {
      if (simLineRef.current >= DEMO_LINES.length) {
        if (simTimerRef.current) clearInterval(simTimerRef.current);
        simTimerRef.current = null;
        setEngine("idle");
        return;
      }
      onFinalRef.current(DEMO_LINES[simLineRef.current]);
      simLineRef.current += 1;
    }, 700);
  };

  const toggle = () => {
    if (VOICE_SIMULATION) {
      toggleSimulation();
      return;
    }
    if (engine === "recording") stopRecognition();
    else startRecognition(); // idle, denied and error all mean "try again"
  };

  const recording = engine === "recording";
  const unsupported = engine === "unsupported";
  const label = LABELS[engine];

  return (
    <div className="mb-[14px] flex items-center gap-[14px] rounded-field border-[1.5px] border-dashed border-line bg-surface-2 px-4 py-[14px]">
      <button
        type="button"
        aria-label={recording ? "إيقاف التسجيل" : "بدء التسجيل"}
        disabled={unsupported}
        onClick={toggle}
        className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded-full border-none text-white",
          recording ? "animate-mic-pulse bg-danger" : "bg-brand",
          unsupported && "cursor-not-allowed opacity-50",
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
        <b
          className={cn(
            "block text-[13.5px] font-semibold",
            engine === "denied" || engine === "error"
              ? "text-danger"
              : "text-ink",
          )}
        >
          {label.title}
        </b>
        <span>{label.hint}</span>
      </div>
    </div>
  );
}
