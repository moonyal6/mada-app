"use client";

import { useMemo, useRef, useState } from "react";
import { toAr } from "@/lib/arabic";
import { fmtDate } from "@/lib/format";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { CLINIC } from "@/lib/config";

type ExerciseView = {
  ar: string;
  en: string;
  desc: string;
  url: string;
  image: string;
};

type AdherenceRow = { day: string; exIdx: number; done: boolean };

const DAY_NAMES = [
  "الأحد",
  "الإثنين",
  "الثلاثاء",
  "الأربعاء",
  "الخميس",
  "الجمعة",
  "السبت",
];

function addDays(day: string, n: number): string {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayName(day: string): string {
  return DAY_NAMES[new Date(day + "T00:00:00Z").getUTCDay()];
}

export function PatientHandout({
  token,
  patientName,
  caseText,
  sessionDate,
  home,
  frequency,
  follow,
  advice,
  exercises,
  today,
  initialAdherence,
  initialPains,
}: {
  token: string;
  patientName: string;
  caseText: string;
  sessionDate: string;
  home: string;
  frequency: string;
  follow: string;
  advice: string;
  exercises: ExerciseView[];
  today: string;
  initialAdherence: AdherenceRow[];
  initialPains: { day: string; pain: number }[];
}) {
  // done["day:idx"] = true
  const [done, setDone] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const r of initialAdherence) {
      if (r.done) map[`${r.day}:${r.exIdx}`] = true;
    }
    return map;
  });
  const [pains, setPains] = useState<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const p of initialPains) map[p.day] = p.pain;
    return map;
  });
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string, error = false) => {
    setNote({ text, error });
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 2500);
  };

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch(`/api/handout/${token}/log`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const toggle = async (exIdx: number) => {
    const key = `${today}:${exIdx}`;
    const next = !done[key];
    setDone((d) => ({ ...d, [key]: next }));
    const ok = await post({ exIdx, done: next });
    if (!ok) {
      setDone((d) => ({ ...d, [key]: !next }));
      flash("تعذّر الحفظ — تحقّق من الاتصال وحاول مجدداً", true);
    } else {
      flash(next ? "أحسنت! سُجّل التمرين ✓" : "أُلغي التسجيل");
    }
  };

  const setPain = async (value: number) => {
    const prev = pains[today];
    setPains((p) => ({ ...p, [today]: value }));
    const ok = await post({ pain: value });
    if (!ok) {
      setPains((p) => {
        const copy = { ...p };
        if (prev === undefined) delete copy[today];
        else copy[today] = prev;
        return copy;
      });
      flash("تعذّر الحفظ — تحقّق من الاتصال وحاول مجدداً", true);
    } else {
      flash("سُجّل مستوى الألم ✓");
    }
  };

  const week = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDays(today, i - 6);
      const doneCount = exercises.filter((_, idx) => done[`${day}:${idx}`]).length;
      return { day, doneCount };
    });
  }, [today, done, exercises]);

  const todayDone = exercises.filter((_, idx) => done[`${today}:${idx}`]).length;
  const planLine = [
    home ? `البرنامج المنزلي: ${home}` : "",
    frequency ? `جلسات العيادة: ${frequency}` : "",
    follow ? `المراجعة: ${follow}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="pt-wrap">
      <div className="pt-head">
        <BrandMark size={38} />
        <div className="t">
          <b>نشرة البرنامج المنزلي</b>
          <span>
            {patientName} · {caseText} · {fmtDate(sessionDate)}
          </span>
        </div>
      </div>

      <div className="pt-card">
        <h2>
          تمارين اليوم{" "}
          <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
            ({toAr(todayDone)}/{toAr(exercises.length)})
          </span>
        </h2>
        <p className="sub">
          {dayName(today)} {fmtDate(today)} — علّم على كل تمرين بعد أدائه.
        </p>
        {exercises.map((ex, idx) => (
          <div className="pt-ex" key={idx}>
            {ex.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="img" src={ex.image} alt="" />
            ) : null}
            <div className="bd">
              <div className="ar">{ex.ar}</div>
              <div className="en">{ex.en}</div>
              <div className="desc">{ex.desc}</div>
              {ex.url ? (
                <a className="vid" href={ex.url} target="_blank" rel="noopener noreferrer">
                  <Icon name="play" size={14} /> شاهد طريقة الأداء
                </a>
              ) : null}
            </div>
            <button
              className={`pt-check${done[`${today}:${idx}`] ? " on" : ""}`}
              onClick={() => toggle(idx)}
              aria-label={`تسجيل ${ex.ar}`}
            >
              <Icon name="check" strokeWidth={3} />
            </button>
          </div>
        ))}
      </div>

      <div className="pt-card">
        <h2>مستوى الألم اليوم</h2>
        <p className="sub">٠ = لا ألم · ١٠ = أشد ألم. يظهر لمعالجك في المتابعة.</p>
        <div className="pt-pain">
          {Array.from({ length: 11 }, (_, n) => (
            <button
              key={n}
              className={pains[today] === n ? "on" : ""}
              onClick={() => setPain(n)}
            >
              {toAr(n)}
            </button>
          ))}
        </div>
      </div>

      <div className="pt-card">
        <h2>أسبوعك</h2>
        <div className="pt-week">
          {week.map(({ day, doneCount }) => (
            <div className={`d${day === today ? " today" : ""}`} key={day}>
              <b>{dayName(day)}</b>
              <div
                className={`dot${
                  doneCount >= exercises.length && exercises.length > 0
                    ? " full"
                    : doneCount > 0
                      ? " part"
                      : ""
                }`}
              />
            </div>
          ))}
        </div>
      </div>

      {advice.trim() ? (
        <div className="pt-card">
          <h2>نصائح معالجك</h2>
          <div style={{ fontSize: 13.5, lineHeight: 1.9, whiteSpace: "pre-wrap" }}>
            {advice}
          </div>
        </div>
      ) : null}

      {planLine ? (
        <div className="pt-card">
          <h2>خطتك</h2>
          <div style={{ fontSize: 13.5 }}>{planLine}</div>
        </div>
      ) : null}

      <div className="pt-saved" style={note?.error ? { color: "var(--danger)" } : undefined}>
        {note?.text ?? ""}
      </div>
      <p className="pt-note">
        هذه النشرة أداة مساعدة ضمن خطة علاجك من {CLINIC.therapist} — راجِع
        معالجك عند أي ألم غير معتاد.
      </p>
    </div>
  );
}
