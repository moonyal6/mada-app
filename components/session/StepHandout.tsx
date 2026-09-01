"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { Icon } from "@/components/icons";
import { useToast } from "@/components/ui/ToastProvider";
import { HandoutCard } from "./HandoutCard";
import type { ClinicalSession, Patient } from "@/lib/types";

export function StepHandout({
  session,
  patient,
}: {
  session: ClinicalSession;
  patient: Patient;
}) {
  const toast = useToast();
  const [portalUrl, setPortalUrl] = useState("");

  useEffect(() => {
    setPortalUrl(`${window.location.origin}/h/${session.handoutToken}`);
  }, [session.handoutToken]);

  if (!Object.keys(session.selected).length) {
    return (
      <div className="card">
        <div className="empty">لا تمارين مختارة. ارجع لخطوة الخطة لاختيار التمارين.</div>
      </div>
    );
  }

  return (
    <>
      <div
        className="card no-print"
        style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
      >
        <button className="btn btn-primary" onClick={() => window.print()}>
          <Icon name="print" /> طباعة / حفظ PDF
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => copyText(portalUrl, toast, "نُسخ رابط نشرة المريض")}
        >
          نسخ رابط نشرة المريض
        </button>
        <span className="sub" style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
          تُبنى من سلّة التمارين.
        </span>
      </div>
      <HandoutCard session={session} patient={patient} portalUrl={portalUrl} />
    </>
  );
}
