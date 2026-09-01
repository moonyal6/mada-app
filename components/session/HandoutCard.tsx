"use client";

import { toAr } from "@/lib/arabic";
import { caseLabel, fmtDate } from "@/lib/format";
import { HANDOUT_DAYS } from "@/lib/data/options";
import { CLINIC } from "@/lib/config";
import { BrandMark } from "@/components/BrandMark";
import { QrCode } from "@/components/QrCode";
import type { ClinicalSession, Patient } from "@/lib/types";

/**
 * The printable handout — the prototype's layout, plus the patient-portal
 * block: scanning the big QR (or opening the link) takes the patient to
 * /h/[token] where they log completion and pain.
 */
export function HandoutCard({
  session,
  patient,
  portalUrl,
}: {
  session: ClinicalSession;
  patient: Patient;
  portalUrl: string;
}) {
  const exercises = Object.values(session.selected);

  return (
    <div className="handout">
      <div className="ho-head">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <BrandMark size={32} />
          <div className="name">مدى</div>
        </div>
        <div className="meta">
          نشرة البرنامج المنزلي
          <br />
          {CLINIC.therapist}
          <br />
          {fmtDate(session.date)}
        </div>
      </div>
      <div className="ho-body">
        <div
          style={{
            fontSize: 13,
            color: "var(--muted)",
            marginBottom: 16,
            paddingBottom: 14,
            borderBottom: "1px solid var(--line-2)",
          }}
        >
          <b style={{ color: "var(--ink)" }}>المريض:</b> {patient.name} ·{" "}
          <b style={{ color: "var(--ink)" }}>الحالة:</b> {caseLabel(patient.caseKey)}
        </div>
        <h4 style={{ color: "var(--brand-dark)", marginBottom: 4 }}>تمارينك اليومية</h4>
        <p style={{ fontSize: 12.5, color: "var(--muted)", margin: "2px 0 10px" }}>
          امسح رمز QR لمشاهدة فيديو كل تمرين.
        </p>
        <div>
          {exercises.map((ex, i) => (
            <div className="ho-ex" key={i}>
              <div className="n">{toAr(i + 1)}</div>
              {ex.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="ex-img" src={ex.image} alt="" />
              ) : null}
              <div style={{ flex: 1 }}>
                <div className="ar" style={{ fontWeight: 600 }}>
                  {ex.ar}
                </div>
                <div
                  className="en"
                  style={{
                    fontSize: 11.5,
                    color: "var(--muted)",
                    direction: "ltr",
                    textAlign: "start",
                  }}
                >
                  {ex.en}
                </div>
                <div className="desc" style={{ fontSize: 12, color: "var(--muted)" }}>
                  {ex.desc}
                </div>
              </div>
              {ex.url ? (
                <QrCode url={ex.url} cellSize={3} margin={0} className="qr" />
              ) : (
                <div className="novid">لا فيديو لهذا التمرين بعد</div>
              )}
            </div>
          ))}
        </div>
        <div className="ho-sched">
          <h4 style={{ color: "var(--brand-dark)", marginBottom: 8 }}>
            جدول الالتزام الأسبوعي
          </h4>
          <div className="sched">
            {HANDOUT_DAYS.map((d) => (
              <div className="d" key={d}>
                <b>{d}</b>
                <div className="box" />
              </div>
            ))}
          </div>
        </div>
        <div className="ho-link">
          <QrCode url={portalUrl} cellSize={3} margin={0} className="qr" />
          <div className="txt">
            <b>نشرتك على جوالك</b>
            امسح الرمز لفتح النشرة، ومتابعة تمارينك اليومية، وتسجيل مستوى الألم —
            يصل ذلك لمعالجك مباشرة.
            <div className="url">{portalUrl}</div>
          </div>
        </div>
      </div>
      <div className="ho-foot">
        هذه النشرة أداة مساعدة ضمن خطة علاجك — التزم بها بين الجلسات، وراجع
        معالجك عند أي ألم غير معتاد.
      </div>
    </div>
  );
}
