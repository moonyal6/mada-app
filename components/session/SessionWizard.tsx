"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { caseLabel } from "@/lib/format";
import { SESS_STEPS } from "@/lib/data/steps";
import { useToast } from "@/components/ui/ToastProvider";
import { useNavRefresh } from "@/components/layout/nav-refresh";
import { Empty } from "@/components/ui/bits";
import { StepAssess } from "./StepAssess";
import { StepPlan } from "./StepPlan";
import { StepReport } from "./StepReport";
import { StepHandout } from "./StepHandout";
import type { ClinicalSession, Patient, SessionDraftPatch } from "@/lib/types";

/** The wizard-persisted subset — what autosave sends. */
function draftPayload(s: ClinicalSession): SessionDraftPatch {
  return {
    step: s.step,
    dialogue: s.dialogue,
    assessment: s.assessment,
    dx: s.dx,
    date: s.date,
    sessionsCount: s.sessionsCount,
    frequency: s.frequency,
    home: s.home,
    follow: s.follow,
    pain: s.pain,
    advice: s.advice,
    planNotes: s.planNotes,
    selected: s.selected,
    suggestedDx: s.suggestedDx,
    report: s.report,
    sealed: s.sealed,
    sealDate: s.sealDate,
  };
}

export function SessionWizard({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const toast = useToast();
  const refreshNav = useNavRefresh();

  const [session, setSession] = useState<ClinicalSession | null>(null);
  const [patient, setPatient] = useState<Patient | null>(null);
  const [missing, setMissing] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [retryTick, setRetryTick] = useState(0);
  const [finishing, setFinishing] = useState(false);
  const lastSavedRef = useRef("");

  useEffect(() => {
    apiGet<{ session: ClinicalSession; patient: Patient }>(
      `/api/sessions/${sessionId}`,
    )
      .then(({ session: s, patient: p }) => {
        lastSavedRef.current = JSON.stringify(draftPayload(s));
        setSession(s);
        setPatient(p);
      })
      .catch(() => setMissing(true));
  }, [sessionId]);

  const update = useCallback(
    (patch: Partial<ClinicalSession>) =>
      setSession((s) => (s ? { ...s, ...patch } : s)),
    [],
  );

  const appendDialogue = useCallback((text: string) => {
    setSession((s) =>
      s
        ? { ...s, dialogue: s.dialogue ? s.dialogue + "\n" + text : text }
        : s,
    );
  }, []);

  // Autosave: debounced, deduped by snapshot so an untouched resume doesn't
  // churn updatedAt; on failure keeps retrying every 4s until it lands.
  useEffect(() => {
    if (!session || session.status !== "draft") return;
    const payload = draftPayload(session);
    const json = JSON.stringify(payload);
    if (json === lastSavedRef.current) return;
    const timer = setTimeout(async () => {
      setSaveState("saving");
      try {
        await apiSend(`/api/sessions/${session.id}`, "PATCH", payload);
        lastSavedRef.current = json;
        setSaveState("saved");
      } catch {
        setSaveState("error");
        setTimeout(() => setRetryTick((t) => t + 1), 4000);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [session, retryTick]);

  // Flush pending changes if the tab closes mid-debounce.
  useEffect(() => {
    const flush = () => {
      if (!session || session.status !== "draft") return;
      const json = JSON.stringify(draftPayload(session));
      if (json === lastSavedRef.current) return;
      void fetch(`/api/sessions/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: json,
        keepalive: true,
      });
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [session]);

  if (missing) {
    return (
      <div className="card">
        <Empty icon="session">
          الجلسة غير موجودة.
          <div style={{ marginTop: 14 }}>
            <Link href="/patients" className="btn btn-primary btn-sm">
              فتح سجل المرضى
            </Link>
          </div>
        </Empty>
      </div>
    );
  }
  if (!session || !patient) return null;

  const setStep = (i: number) => update({ step: i });

  const finish = async () => {
    setFinishing(true);
    try {
      // Make sure the latest edits are on the row before finalising.
      await apiSend(`/api/sessions/${session.id}`, "PATCH", draftPayload(session));
      await apiSend(`/api/sessions/${session.id}/finish`, "POST");
      toast("حُفظت الجلسة وأُنشئت فاتورتها");
      refreshNav();
      router.push(`/patients/${patient.id}`);
    } catch {
      toast("تعذّر حفظ الجلسة");
      setFinishing(false);
    }
  };

  const saveHint =
    session.status !== "draft"
      ? "جلسة منتهية"
      : saveState === "saving"
        ? "يحفظ…"
        : saveState === "error"
          ? "تعذّر الحفظ — يُعاد تلقائياً"
          : saveState === "saved"
            ? "حُفظ تلقائياً"
            : "";

  return (
    <>
      <div className="no-print" style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <Link href={`/patients/${patient.id}`} className="btn btn-ghost btn-sm">
          → {patient.name}
        </Link>
        <span className="badge grey">{caseLabel(patient.caseKey)}</span>
        <div style={{ flex: 1 }} />
        <span
          className="meta"
          style={{
            fontSize: 12,
            color: saveState === "error" ? "var(--danger)" : "var(--muted)",
          }}
        >
          {saveHint}
        </span>
      </div>
      <div className="wiz-steps no-print">
        {SESS_STEPS.map((t, i) => (
          <div
            key={t}
            className={`wiz-step ${i === session.step ? "on" : i < session.step ? "done" : ""}`}
            onClick={() => setStep(i)}
          >
            <span className="n">{i < session.step ? "✓" : toAr(i + 1)}</span>
            {t}
          </div>
        ))}
      </div>

      <div>
        {session.step === 0 ? (
          <StepAssess
            session={session}
            update={update}
            appendDialogue={appendDialogue}
          />
        ) : session.step === 1 ? (
          <StepPlan session={session} patient={patient} update={update} />
        ) : session.step === 2 ? (
          <StepReport session={session} patient={patient} update={update} />
        ) : (
          <StepHandout session={session} patient={patient} />
        )}
      </div>

      <div className="no-print" style={{ display: "flex", gap: 10, marginTop: 18 }}>
        {session.step > 0 ? (
          <button className="btn btn-ghost" onClick={() => setStep(session.step - 1)}>
            السابق
          </button>
        ) : null}
        <div style={{ flex: 1 }} />
        {session.step < 3 ? (
          <button className="btn btn-primary" onClick={() => setStep(session.step + 1)}>
            التالي
          </button>
        ) : session.status === "draft" ? (
          <button className="btn btn-primary" onClick={finish} disabled={finishing}>
            إنهاء وحفظ الجلسة
          </button>
        ) : null}
      </div>
    </>
  );
}
