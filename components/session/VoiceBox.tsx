"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { Icon } from "@/components/icons";
import { SegmentedRecorder, type RecorderSnapshot } from "@/lib/voice/recorder";
import { STT_AUTO, writeSttCookie } from "@/lib/stt";
import type { ClinicalSession, SegmentInfo, SttStatus } from "@/lib/types";

/**
 * The voice assistant box: consent gate → segmented recording → live
 * transcript polling. Finalized segment texts are appended to the dialogue
 * in seq order; a failed segment holds the cursor (order must not scramble)
 * and surfaces as a visible retry with the reason in plain Arabic.
 *
 * The provider picker beside the recorder lists what the server has
 * configured (names and availability only — never keys) and stores the
 * device's choice in a cookie the server reads per uploaded segment.
 */

/** What the transcript polling learned beyond texts: who did the work, what was skipped. */
type Outcome = {
  /** Provider that produced the most recent finished text. */
  provider: string;
  /** True when that text came from a later provider than the first choice. */
  failedOver: boolean;
  silence: number;
  dropped: number;
  /** The most recent failed segment's Arabic explanation. */
  failure: string;
};

const NO_OUTCOME: Outcome = { provider: "", failedOver: false, silence: 0, dropped: 0, failure: "" };

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
  const [outcome, setOutcome] = useState<Outcome>(NO_OUTCOME);

  const recorderRef = useRef<SegmentedRecorder | null>(null);
  const watchersRef = useRef<Watcher[]>([]);
  const consentedRef = useRef<boolean>(!!session.consentAt);
  consentedRef.current = !!session.consentAt;

  const loadStt = useCallback(() => {
    apiGet<SttStatus>("/api/stt").then(setStt).catch(() => {});
  }, []);
  useEffect(loadStt, [loadStt]);

  const pickProvider = useCallback(
    (key: string) => {
      writeSttCookie(key);
      setStt((s) => (s ? { ...s, selected: key } : s));
      loadStt();
    },
    [loadStt],
  );

  // Poll transcript status for every recording opened in this mount.
  useEffect(() => {
    const timer = setInterval(async () => {
      const watchers = watchersRef.current;
      if (!watchers.length) return;
      let transcribingCount = 0;
      let failedCount = 0;
      const seen: Outcome = { ...NO_OUTCOME };
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
        for (const s of segments) {
          if (s.status === "done") {
            if (s.note === "silence") seen.silence += 1;
            else if (s.note === "degenerate") seen.dropped += 1;
            if (s.provider && s.text) {
              seen.provider = s.provider;
              seen.failedOver = s.note === "failover";
            }
          } else if (s.status === "failed" && s.error) {
            seen.failure = s.error;
          }
        }
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
      setOutcome(seen);
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
    const via = outcome.provider || stt?.providerLabel;
    label = via ? `يسجّل — التفريغ عبر ${via}` : "يسجّل…";
    sub = "اضغط للإيقاف · يُرفَع تباعاً كل ١٥ ثانية";
  } else if (snap.phase === "draining") {
    label = "أُوقف التسجيل — جارٍ رفع ما تبقّى…";
    sub = "";
  } else {
    label = "اضغط لبدء التوثيق الصوتي";
    sub = "أو اكتب الحوار في الحقل أدناه";
  }

  const localProvider = stt?.keepsAudioLocal ?? false;
  const chainText = stt?.chain.join("، وعند تعذّره ") ?? "";
  const autoLabel = stt?.chain.length
    ? `تلقائي — ${stt.chain.join(" ثم ")}`
    : "تلقائي — لا مزوّد مهيّأ";

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
          {outcome.provider && !recording ? (
            <span className={`badge ${outcome.failedOver ? "gold" : "grey"}`}>
              {outcome.failedOver
                ? `تحوّل تلقائياً إلى ${outcome.provider}`
                : `تمّ التفريغ عبر ${outcome.provider}`}
            </span>
          ) : outcome.failedOver ? (
            <span className="badge gold">تحوّل تلقائياً إلى {outcome.provider}</span>
          ) : null}
          {outcome.silence > 0 ? (
            <span className="badge grey">تم تجاوز {toAr(outcome.silence)} مقطع صامت</span>
          ) : null}
          {outcome.dropped > 0 ? (
            <span className="badge gold">أُهمل {toAr(outcome.dropped)} مقطع غير مفهوم</span>
          ) : null}
        </div>
        {stt ? (
          <label className="stt-pick">
            <span>مزوّد التفريغ</span>
            <select
              value={stt.selected}
              onChange={(e) => pickProvider(e.target.value)}
              aria-label="مزوّد التفريغ الصوتي"
              title="يُحفَظ الاختيار على هذا الجهاز ويسري من المقطع التالي"
            >
              <option value={STT_AUTO}>{autoLabel}</option>
              {stt.providers.map((p) => (
                <option key={p.key} value={p.key} disabled={!p.available}>
                  {p.available ? p.label : `${p.label} — غير متاح: ${p.reason ?? ""}`}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {failed > 0 && outcome.failure ? (
          <div className="voice-note" role="alert">
            {outcome.failure}
          </div>
        ) : null}
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
                  • يُرسَل الصوت إلى مزوّد التفريغ ({chainText || "غير مهيّأ"})
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
