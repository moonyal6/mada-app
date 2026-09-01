"use client";

import { useRef, useState } from "react";
import { apiSend } from "@/lib/api";
import { buildPackage } from "@/lib/buildPackage";
import { copyText } from "@/lib/clipboard";
import { CLINIC } from "@/lib/config";
import { Icon } from "@/components/icons";
import { Spinner } from "@/components/ui/bits";
import { ReportMarkdown } from "@/components/report/ReportMarkdown";
import { useToast } from "@/components/ui/ToastProvider";
import type { ClinicalSession, Patient } from "@/lib/types";

export function StepReport({
  session,
  patient,
  update,
}: {
  session: ClinicalSession;
  patient: Patient;
  update: (patch: Partial<ClinicalSession>) => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"direct" | "manual">("direct");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  // Preview is the default reading view; edit is one click away. Sealed means
  // read-only in both views.
  const [view, setView] = useState<"preview" | "edit">("preview");
  // Once the panel has been shown, it stays — clearing the text mid-edit must
  // not make the editor vanish under the cursor. The only two ways a report
  // appears are the handlers below, so they latch it.
  const [draftShown, setDraftShown] = useState(!!session.report);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  const pkg = buildPackage(patient, session);

  const generate = async () => {
    setGenerating(true);
    setGenError(null);
    try {
      const { text } = await apiSend<{ text: string }>("/api/report", "POST", {
        pkg,
      });
      update({ report: text, sealed: false, sealDate: "" });
      setDraftShown(true);
      setView("preview");
    } catch {
      setGenError(
        "تعذّر توليد التقرير — حاول مجدداً، أو استخدم وضع «نسخ ولصق يدوي».",
      );
    } finally {
      setGenerating(false);
    }
  };

  const loadPaste = () => {
    const t = pasteRef.current?.value.trim() ?? "";
    if (!t) {
      toast("الصق التقرير أولاً");
      return;
    }
    update({ report: t, sealed: false, sealDate: "" });
    setDraftShown(true);
    setView("preview");
  };

  const seal = () => {
    if (!session.report.trim()) {
      toast("لا يوجد تقرير");
      return;
    }
    update({
      sealed: true,
      sealDate: new Date().toLocaleDateString("ar-SA-u-ca-gregory", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    });
    setView("preview");
    toast("اعتُمد التقرير");
  };

  const unseal = () => {
    update({ sealed: false });
    setView("edit");
  };

  const showDraft = draftShown || !!session.report;

  return (
    <div className="card">
      <div className="mode-toggle">
        <button className={mode === "direct" ? "on" : ""} onClick={() => setMode("direct")}>
          توليد مباشر
        </button>
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>
          نسخ ولصق يدوي
        </button>
      </div>
      <h3>حزمة الصياغة</h3>
      <p className="sub">ما يُرسَل للصياغة.</p>
      <div className="pkg">{pkg}</div>

      {mode === "direct" ? (
        <div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn-primary" onClick={generate} disabled={generating}>
              <Icon name="sparkle" /> توليد التقرير
            </button>
            <button className="btn btn-ghost" onClick={() => copyText(pkg, toast, "نُسخت الحزمة")}>
              نسخ الحزمة
            </button>
          </div>
          {generating ? (
            <div className="status-line">
              <Spinner /> جارٍ الصياغة عبر كلود…
            </div>
          ) : null}
          {genError ? (
            <div className="status-line" style={{ color: "var(--danger)" }}>
              {genError}
            </div>
          ) : null}
        </div>
      ) : (
        <div>
          <button
            className="btn btn-primary"
            style={{ marginBottom: 12 }}
            onClick={() => copyText(pkg, toast, "نُسخت الحزمة")}
          >
            نسخ الحزمة
          </button>
          <p className="sub">الصق نص التقرير الناتج هنا. هذا الحقل للّصق فقط ولا يُملأ تلقائياً.</p>
          <textarea ref={pasteRef} className="tall" autoComplete="off" />
          <div className="paste-flag">
            <Icon name="shield" /> حقل لصق فقط — حفاظاً على تأليف الطبيب.
          </div>
          <button className="btn btn-soft" style={{ marginTop: 10 }} onClick={loadPaste}>
            مراجعة التقرير الملصوق
          </button>
        </div>
      )}

      {showDraft ? (
        <div className={`report-draft${session.sealed ? " sealed" : ""}`}>
          <div className="rh">
            <span style={{ flex: 1 }}>
              {session.sealed
                ? "التقرير معتمد بختم الطبيب."
                : "مسودّة التقرير — راجِع واعتمد. لك حرية التعديل."}
            </span>
            {!session.sealed ? (
              <span className="mode-toggle" style={{ margin: 0, padding: 2 }}>
                <button
                  className={view === "preview" ? "on" : ""}
                  onClick={() => setView("preview")}
                >
                  معاينة
                </button>
                <button
                  className={view === "edit" ? "on" : ""}
                  onClick={() => setView("edit")}
                >
                  تحرير
                </button>
              </span>
            ) : null}
          </div>
          {view === "edit" && !session.sealed ? (
            <textarea
              value={session.report}
              onChange={(e) => update({ report: e.target.value })}
            />
          ) : (
            <div className="report-preview">
              <ReportMarkdown text={session.report} />
            </div>
          )}
          <div className="rf">
            {!session.sealed ? (
              <button className="btn btn-gold" onClick={seal}>
                <Icon name="sealCheck" /> اعتماد بختم الطبيب
              </button>
            ) : (
              <div className="seal">
                <span className="st">✓</span>
                <div>
                  <b>معتمد</b> — {CLINIC.therapist} · <span>{session.sealDate}</span>
                </div>
              </div>
            )}
            <div style={{ flex: 1 }} />
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => copyText(session.report, toast, "نُسخ التقرير")}
            >
              نسخ
            </button>
            {session.sealed ? (
              <button className="btn btn-ghost btn-sm" onClick={unseal}>
                إلغاء الاعتماد للتعديل
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
