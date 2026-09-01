"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { Icon } from "@/components/icons";
import { SegmentedRecorder, type RecorderSnapshot } from "@/lib/voice/recorder";
import type { ClinicalSession, SegmentInfo, SttStatus } from "@/lib/types";

/**
 * The voice assistant box: consent gate → segmented recording → live
 * transcript polling. Finalized segment texts are appended to the dialogue
 * in seq order; a failed segment holds the cursor (order must not scramble)
 * and surfaces as a visible retry.
 */

type Watcher = {
  recordingId: string;
  cursor: number; // next seq to apply
  active: boolean; // still recording into it
};

const IDLE: RecorderSnapshot = {
  phase: "idle",
  error: null,
  recordingId: null,
  captured: 0,
  pendingUpload: 0,
  offline: false,
};

export function VoiceBox({
  session,
  onConsented,
  onTranscript,
}: {
  session: ClinicalSession;
  onConsented: (s: ClinicalSession) => void;
  onTranscript: (text: string) => void;
}) {
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [snap, setSnap] = useState<RecorderSnapshot>(IDLE);
  const [consentOpen, setConsentOpen] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(0);
  const [failed, setFailed] = useState<number>(0);

  const recorderRef = useRef<SegmentedRecorder | null>(null);
  const watchersRef = useRef<Watcher[]>([]);
  const consentedRef = useRef<boolean>(!!session.consentAt);
  consentedRef.current = !!session.consentAt;

  useEffect(() => {
    apiGet<SttStatus>("/api/stt").then(setStt).catch(() => {});
  }, []);

  // Poll transcript status for every recording opened in this mount.
  useEffect(() => {
    const timer = setInterval(async () => {
      const watchers = watchersRef.current;
      if (!watchers.length) return;
      let transcribingCount = 0;
      let failedCount = 0;
      for (const w of [...watchers]) {
        let segments: SegmentInfo[];
        try {
          ({ segments } = await apiGet<{ segments: SegmentInfo[] }>(
            `/api/recordings/${w.recordingId}`,
          ));
        } catch {
          continue;
        }
        const bySeq = new Map(segments.map((s) => [s.seq, s]));
        // Apply finalized texts strictly in order.
        for (;;) {
          const next = bySeq.get(w.cursor);
          if (!next || next.status !== "done") break;
          if (next.text) onTranscript(next.text);
          w.cursor += 1;
        }
        transcribingCount += segments.filter(
          (s) => s.status === "uploaded" || s.status === "transcribing",
        ).length;
        failedCount += segments.filter((s) => s.status === "failed").length;
        const exhausted =
          !w.active &&
          segments.every((s) => s.status === "done" || s.status === "failed") &&
          w.cursor >= segments.length &&
          segments.filter((s) => s.status === "failed").length === 0;
        if (exhausted) {
          watchersRef.current = watchersRef.current.filter(
            (x) => x.recordingId !== w.recordingId,
          );
        }
      }
      setTranscribing(transcribingCount);
      setFailed(failedCount);
    }, 2500);
    return () => clearInterval(timer);
  }, [onTranscript]);

  // The voiceToggle-bug antidote: teardown on unmount, always.
  useEffect(() => {
    return () => {
      recorderRef.current?.destroy();
    };
  }, []);

  const begin = useCallback(async () => {
    const recorder = new SegmentedRecorder({
      sessionId: session.id,
      onChange: (s) => {
        setSnap(s);
        if (s.recordingId) {
          const w = watchersRef.current.find(
            (x) => x.recordingId === s.recordingId,
          );
          if (!w) {
            watchersRef.current.push({
              recordingId: s.recordingId,
              cursor: 0,
              active: true,
            });
          } else {
            w.active = s.phase === "recording" || s.phase === "starting";
          }
        }
      },
    });
    recorderRef.current = recorder;
    await recorder.start();
  }, [session.id]);

  const micClick = useCallback(async () => {
    if (snap.phase === "recording" || snap.phase === "starting") {
      recorderRef.current?.stop();
      const id = recorderRef.current?.recordingId;
      const w = watchersRef.current.find((x) => x.recordingId === id);
      if (w) w.active = false;
      return;
    }
    if (!consentedRef.current) {
      setConsentChecked(false);
      setConsentOpen(true);
      return;
    }
    await begin();
  }, [snap.phase, begin]);

  const confirmConsent = useCallback(async () => {
    setConsentBusy(true);
    try {
      const { session: updated } = await apiSend<{ session: ClinicalSession }>(
        `/api/sessions/${session.id}/consent`,
        "POST",
      );
      consentedRef.current = true;
      onConsented(updated);
      setConsentOpen(false);
      await begin();
    } catch {
      /* leave the modal open; the therapist can retry */
    } finally {
      setConsentBusy(false);
    }
  }, [session.id, onConsented, begin]);

  const retryFailed = useCallback(async () => {
    for (const w of watchersRef.current) {
      let segments: SegmentInfo[] = [];
      try {
        ({ segments } = await apiGet<{ segments: SegmentInfo[] }>(
          `/api/recordings/${w.recordingId}`,
        ));
      } catch {
        continue;
      }
      for (const s of segments) {
        if (s.status === "failed") {
          await apiSend(
            `/api/recordings/${w.recordingId}/segments/${s.seq}/retry`,
            "POST",
          ).catch(() => {});
        }
      }
    }
  }, []);

  const recording = snap.phase === "recording" || snap.phase === "starting";
  const sttBlocked = stt !== null && !stt.ready;

  let label: string;
  let sub: string;
  if (snap.phase === "error") {
    label = snap.error ?? "تعذّر التسجيل.";
    sub = "يمكنك الكتابة يدوياً في الحقل أدناه، أو إعادة المحاولة.";
  } else if (sttBlocked) {
    label = "التفريغ الصوتي غير مهيّأ";
    sub = stt?.reason ?? "";
  } else if (snap.phase === "starting") {
    label = "جارٍ تجهيز الميكروفون…";
    sub = "";
  } else if (snap.phase === "recording") {
    label = stt?.providerLabel
      ? `يسجّل — التفريغ عبر ${stt.providerLabel}`
      : "يسجّل…";
    sub = "اضغط للإيقاف · يُرفَع تباعاً كل ١٥ ثانية";
  } else if (snap.phase === "draining") {
    label = "أُوقف التسجيل — جارٍ رفع ما تبقّى…";
    sub = "";
  } else {
    label = "اضغط لبدء التوثيق الصوتي";
    sub = "أو اكتب الحوار في الحقل أدناه";
  }

  const localProvider = stt?.providerLabel?.includes("محلي");

  return (
    <>
      <div className={`voice${recording ? " rec" : ""}`}>
        <button
          className="mic"
          onClick={micClick}
          disabled={sttBlocked || snap.phase === "draining"}
          aria-label={recording ? "إيقاف التسجيل" : "بدء التسجيل"}
        >
          <Icon name="mic" size={19} />
        </button>
        <div className="vt">
          <b style={snap.phase === "error" ? { color: "var(--danger)" } : undefined}>
            {label}
          </b>
          <span>{sub}</span>
        </div>
        <div className="segchips">
          {snap.offline ? (
            <span className="badge red">
              <span className="dot" />
              انقطع الاتصال — يُعاد الرفع تلقائياً ({toAr(snap.pendingUpload)})
            </span>
          ) : snap.pendingUpload > 0 ? (
            <span className="badge gold">
              بانتظار الرفع: {toAr(snap.pendingUpload)}
            </span>
          ) : null}
          {transcribing > 0 ? (
            <span className="badge grey">جارٍ التفريغ: {toAr(transcribing)}</span>
          ) : null}
          {failed > 0 ? (
            <button className="btn btn-danger btn-sm" onClick={retryFailed}>
              تعذّر تفريغ {toAr(failed)} — إعادة المحاولة
            </button>
          ) : null}
          {snap.phase === "error" ? (
            <button className="btn btn-ghost btn-sm" onClick={() => void begin()}>
              إعادة المحاولة
            </button>
          ) : null}
        </div>
      </div>

      {consentOpen ? (
        <div className="modal-scrim" onClick={() => !consentBusy && setConsentOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>موافقة المريض على التسجيل</h3>
            <div className="consent-text">
              • يُسجَّل صوت الجلسة عبر ميكروفون هذا الجهاز.
              <br />
              • يُرفَع التسجيل تباعاً إلى خادم العيادة أثناء الجلسة.
              <br />
              {localProvider ? (
                <>
                  • يُحوَّل الصوت إلى نص على خادم العيادة نفسه (Whisper محلي) دون
                  إرساله لأي خدمة خارجية، ويُحفَظ النص في ملف الجلسة.
                </>
              ) : (
                <>
                  • يُرسَل الصوت إلى مزوّد التفريغ ({stt?.providerLabel ?? "غير مهيّأ"})
                  لتحويله إلى نص، ويُحفَظ النص في ملف الجلسة.
                </>
              )}
              <br />
              • يبقى الملف الصوتي محفوظاً على خادم العيادة، ويُحذف عند طلب المريض.
            </div>
            <label className="consent-check">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(e) => setConsentChecked(e.target.checked)}
              />
              <span>
                أؤكّد أنني أوضحت ذلك للمريض وحصلت على موافقته قبل بدء التسجيل.
              </span>
            </label>
            <div className="actions">
              <button
                className="btn btn-primary"
                disabled={!consentChecked || consentBusy}
                onClick={confirmConsent}
              >
                <Icon name="mic" /> بدء التسجيل
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setConsentOpen(false)}
                disabled={consentBusy}
              >
                إلغاء
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
