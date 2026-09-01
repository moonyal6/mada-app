"use client";

import { useState } from "react";
import { apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { EX } from "@/lib/data/exercises";
import { DX_SUGGEST } from "@/lib/data/diagnoses";
import { ADVICE_COMMON } from "@/lib/data/advice";
import {
  FOLLOW_OPTS,
  FREQ_OPTS,
  HOME_OPTS,
  PAIN_OPTS,
  SESSION_OPTS,
} from "@/lib/data/options";
import { REFERENCE_LIBRARY } from "@/lib/data/reference-library";
import { Icon } from "@/components/icons";
import { Spinner } from "@/components/ui/bits";
import { QrCode } from "@/components/QrCode";
import { useToast } from "@/components/ui/ToastProvider";
import type { ClinicalSession, Patient, SelectedExercise } from "@/lib/types";

function ChipRow({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o}
          className={`chip-btn${value === o ? " on" : ""}`}
          onClick={() => onChange(value === o ? "" : o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

type AiSuggestion = { ar: string; en: string; desc: string };

export function StepPlan({
  session,
  patient,
  update,
}: {
  session: ClinicalSession;
  patient: Patient;
  update: (patch: Partial<ClinicalSession>) => void;
}) {
  const toast = useToast();
  const caseExercises = EX[patient.caseKey] ?? [];
  const ref = REFERENCE_LIBRARY[patient.caseKey];

  const [exQuery, setExQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);
  const [addedIdx, setAddedIdx] = useState<Set<number>>(new Set());

  const insertLine = (field: "dx" | "advice", text: string) => {
    const cur = session[field].trim();
    update({ [field]: cur ? cur + "\n" + text : text });
  };

  const toggleCaseEx = (i: number) => {
    const id = `case-${patient.caseKey}-${i}`;
    const next = { ...session.selected };
    if (next[id]) {
      delete next[id];
    } else {
      const ex = caseExercises[i];
      next[id] = {
        ar: ex.ar,
        en: ex.en,
        desc: ex.desc,
        url: ex.video || "",
        image: ex.image,
        source: "case",
      };
    }
    update({ selected: next });
  };

  const addSuggestion = (i: number) => {
    const ex = aiSuggestions[i];
    if (!ex) return;
    const maxN = Object.keys(session.selected)
      .filter((k) => k.startsWith("add-"))
      .reduce((m, k) => Math.max(m, Number(k.slice(4)) || 0), 0);
    const next: Record<string, SelectedExercise> = {
      ...session.selected,
      [`add-${maxN + 1}`]: {
        ar: ex.ar,
        en: ex.en || "",
        desc: ex.desc || "",
        url: "",
        source: "added",
      },
    };
    setAddedIdx(new Set(addedIdx).add(i));
    update({ selected: next });
    toast("أُضيف للسلّة");
  };

  const search = async () => {
    const q = exQuery.trim();
    if (!q) {
      toast("اكتب اسم التمرين أو الهدف");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setAiSuggestions([]);
    setAddedIdx(new Set());
    try {
      const { exercises } = await apiSend<{ exercises: AiSuggestion[] }>(
        "/api/exercises",
        "POST",
        { query: q },
      );
      setAiSuggestions(exercises);
    } catch {
      setSearchError("تعذّر الاقتراح — تحقّق من الاتصال ثم حاول مجدداً.");
    } finally {
      setSearching(false);
    }
  };

  const setExUrl = (id: string, url: string) => {
    const next = { ...session.selected };
    if (next[id]) next[id] = { ...next[id], url };
    update({ selected: next });
  };

  const removeEx = (id: string) => {
    const next = { ...session.selected };
    delete next[id];
    update({ selected: next });
  };

  const basket = Object.entries(session.selected);

  return (
    <>
      <div className="card">
        <h3>رأي الطبيب المعتمد</h3>
        <p className="sub">اختر بنقرة قدر الإمكان. القرار والصياغة النهائية لك.</p>
        <div className="field">
          <label>التشخيص المعتمد</label>
          <textarea
            placeholder="…"
            value={session.dx}
            onChange={(e) => update({ dx: e.target.value })}
          />
          {session.suggestedDx.length ? (
            <>
              <div className="chips-label">
                اقتراح من حوار الجلسة <span className="src-tag">للمراجعة — القرار لك</span>
              </div>
              <div className="chips">
                {session.suggestedDx.map((t) => (
                  <button
                    key={t}
                    className="chip-btn insert"
                    onClick={() => insertLine("dx", t)}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <div className="chips-label">تشخيصات شائعة:</div>
          <div className="chips">
            {(DX_SUGGEST[patient.caseKey] ?? []).map((t) => (
              <button
                key={t}
                className="chip-btn insert"
                onClick={() => insertLine("dx", t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {ref ? (
          <div className="reflib">
            <h4>
              <Icon name="book" size={14} /> إرشاد داعم من المكتبة المرجعية{" "}
              <span className="src-tag" style={{ marginInlineStart: 6 }}>
                {ref.status}
              </span>
            </h4>
            <ul>
              {ref.summary.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            {ref.refs.map((r) => (
              <div className="lnk" key={r.url}>
                <a href={r.url} target="_blank" rel="noopener noreferrer">
                  {r.source} ↗
                </a>
              </div>
            ))}
          </div>
        ) : (
          <div
            className="reflib"
            style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
          >
            <span className="meta" style={{ fontSize: 12.5, color: "var(--muted)" }}>
              المكتبة المرجعية لهذه الحالة بانتظار الإعداد والاعتماد.
            </span>
          </div>
        )}

        <div className="grid3" style={{ marginTop: 14 }}>
          <div className="field">
            <label>تاريخ الجلسة</label>
            <input
              type="date"
              value={session.date}
              onChange={(e) => update({ date: e.target.value })}
            />
          </div>
          <div className="field">
            <label>عدد الجلسات</label>
            <ChipRow
              options={SESSION_OPTS}
              value={session.sessionsCount}
              onChange={(v) => update({ sessionsCount: v })}
            />
          </div>
          <div className="field">
            <label>التكرار</label>
            <ChipRow
              options={FREQ_OPTS}
              value={session.frequency}
              onChange={(v) => update({ frequency: v })}
            />
          </div>
        </div>
        <div className="grid3">
          <div className="field">
            <label>البرنامج المنزلي</label>
            <ChipRow
              options={HOME_OPTS}
              value={session.home}
              onChange={(v) => update({ home: v })}
            />
          </div>
          <div className="field">
            <label>المتابعة</label>
            <ChipRow
              options={FOLLOW_OPTS}
              value={session.follow}
              onChange={(v) => update({ follow: v })}
            />
          </div>
          <div className="field">
            <label>
              شدة الألم <span className="opt">0–10</span>
            </label>
            <div className="chips">
              {PAIN_OPTS.map((n) => {
                const v = `${toAr(n)} / ١٠`;
                const on = session.pain === v;
                return (
                  <button
                    key={n}
                    className={`chip-btn num${on ? " on" : ""}`}
                    onClick={() => update({ pain: on ? "" : v })}
                  >
                    {toAr(n)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div className="field last">
          <label>نصائح وإرشادات للمريض</label>
          <div className="chips-label">نصائح جاهزة:</div>
          <div className="chips">
            {ADVICE_COMMON.map((t) => (
              <button
                key={t}
                className="chip-btn insert"
                onClick={() => insertLine("advice", t)}
              >
                {t}
              </button>
            ))}
          </div>
          <textarea
            style={{ marginTop: 8 }}
            placeholder="…"
            value={session.advice}
            onChange={(e) => update({ advice: e.target.value })}
          />
        </div>
      </div>

      <div className="card">
        <h3>تمارين الحالة</h3>
        <p className="sub">
          انقر لإضافة التمرين إلى السلّة. أوصاف التمارين والرسوم محتوى مبدئي
          بانتظار اعتماد المشرف السريري.
        </p>
        <div className="ex-list">
          {caseExercises.map((ex, i) => {
            const id = `case-${patient.caseKey}-${i}`;
            const on = !!session.selected[id];
            return (
              <div className={`ex${on ? " sel" : ""}`} key={id}>
                <div
                  className="ex-top"
                  style={{ cursor: "pointer" }}
                  onClick={() => toggleCaseEx(i)}
                >
                  <div className="ex-check">
                    <Icon name="check" strokeWidth={3} />
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="ex-img" src={ex.image} alt="" />
                  <div style={{ flex: 1 }}>
                    <div className="en">{ex.en}</div>
                    <div className="ar">{ex.ar}</div>
                    <div className="desc">{ex.desc}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <h3>إضافة تمارين لمشكلات مرتبطة</h3>
        <p className="sub">اكتب اسم تمرين أو هدفاً علاجياً.</p>
        <div className="toolbar">
          <div className="search" style={{ flex: 1 }}>
            <Icon name="search" />
            <input
              type="text"
              placeholder="مثال: تقوية عضلات لوح الكتف"
              value={exQuery}
              onChange={(e) => setExQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void search();
              }}
            />
          </div>
          <button className="btn btn-primary" onClick={search} disabled={searching}>
            اقترح
          </button>
        </div>
        {searching ? (
          <div className="status-line">
            <Spinner /> جارٍ الاقتراح…
          </div>
        ) : null}
        {searchError ? (
          <div className="status-line" style={{ color: "var(--danger)" }}>
            {searchError}
          </div>
        ) : null}
        <div className="ex-list">
          {aiSuggestions.map((ex, i) => (
            <div className="ex" key={`${ex.ar}-${i}`}>
              <div className="ex-top">
                <div style={{ flex: 1 }}>
                  <div className="en">{ex.en}</div>
                  <div className="ar">{ex.ar}</div>
                  <div className="desc">{ex.desc}</div>
                </div>
                <button
                  className="btn btn-soft btn-sm btn-add"
                  disabled={addedIdx.has(i)}
                  onClick={() => addSuggestion(i)}
                >
                  {addedIdx.has(i) ? "أُضيف" : "أضف"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3>سلّة التمارين ({toAr(basket.length)})</h3>
        <p className="sub">تدخل في التقرير ونشرة المريض.</p>
        <div className="ex-list">
          {basket.length ? (
            basket.map(([id, ex]) => (
              <div className="ex sel" key={id}>
                <div className="ex-top">
                  {ex.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="ex-img" src={ex.image} alt="" />
                  ) : null}
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="ar">{ex.ar}</span>
                      {ex.source === "added" ? (
                        <span className="src-tag">مضاف</span>
                      ) : null}
                    </div>
                    <div className="en">{ex.en}</div>
                    <div className="desc">{ex.desc}</div>
                    <div className="field last" style={{ marginTop: 8 }}>
                      <label style={{ fontSize: 11, color: "var(--muted)" }}>
                        رابط الفيديو (QR)
                      </label>
                      <input
                        type="text"
                        value={ex.url}
                        onChange={(e) => setExUrl(id, e.target.value)}
                        style={{
                          direction: "ltr",
                          textAlign: "start",
                          fontSize: 12,
                          padding: "7px 10px",
                        }}
                      />
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {ex.url ? (
                      <QrCode url={ex.url} cellSize={3} margin={0} className="bq" />
                    ) : (
                      <div className="bq novid">لا فيديو بعد</div>
                    )}
                    <button className="btn btn-danger btn-sm" onClick={() => removeEx(id)}>
                      إزالة
                    </button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty" style={{ padding: 20 }}>
              لم تُختر تمارين بعد.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
