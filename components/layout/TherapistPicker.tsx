"use client";

import { useRef, useState } from "react";
import { CLINIC } from "@/lib/config";
import {
  initialsOf,
  normalizeTherapist,
  readTherapistList,
  writeTherapistCookie,
  writeTherapistList,
} from "@/lib/therapist";

/**
 * Sidebar identity block + name picker. Who is using this device right now;
 * stamped onto every session started from here. Attribution only — it
 * filters nothing and everyone still sees everything.
 */
export function TherapistPicker({
  value,
  onChange,
}: {
  /** Current device name ("" = nothing chosen yet → clinic fallback). */
  value: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Read lazily on open (localStorage is client-only; the shell SSRs).
  const [list, setList] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = value || CLINIC.therapist;

  const toggle = () => {
    if (!open) setList(readTherapistList());
    setOpen((v) => !v);
  };

  const choose = (name: string) => {
    const v = normalizeTherapist(name);
    if (!v) return;
    writeTherapistCookie(v);
    if (!list.includes(v)) {
      const next = [...list, v];
      writeTherapistList(next);
      setList(next);
    }
    onChange(v);
    setOpen(false);
  };

  const addTyped = () => {
    const v = normalizeTherapist(inputRef.current?.value ?? "");
    if (!v) return;
    if (inputRef.current) inputRef.current.value = "";
    choose(v);
  };

  const remove = (name: string) => {
    const next = list.filter((n) => n !== name);
    writeTherapistList(next);
    setList(next.length ? next : readTherapistList());
    if (name === value) {
      writeTherapistCookie("");
      onChange("");
    }
  };

  return (
    <div className="who">
      <button
        type="button"
        className="side-foot who-btn"
        onClick={toggle}
        aria-expanded={open}
        aria-label="اختيار المعالج"
        title="اختيار المعالج الذي يستخدم هذا الجهاز"
      >
        <span className="av">{initialsOf(shown)}</span>
        <div className="who-txt">
          {shown}
          <br />
          <span style={{ fontSize: 11 }}>{CLINIC.name}</span>
        </div>
        <svg
          className="who-caret"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>

      {open ? (
        <div className="who-pop" role="dialog" aria-label="المعالج الحالي">
          <div className="who-title">من يستخدم هذا الجهاز؟</div>
          <div className="who-list">
            {list.map((n) => (
              <div className={`who-item${n === shown ? " on" : ""}`} key={n}>
                <button type="button" className="who-pick" onClick={() => choose(n)}>
                  <span className="av">{initialsOf(n)}</span>
                  <span className="who-name">{n}</span>
                  {n === shown ? <span className="who-check">✓</span> : null}
                </button>
                {n !== CLINIC.therapist ? (
                  <button
                    type="button"
                    className="who-x"
                    aria-label={`حذف ${n} من القائمة`}
                    onClick={() => remove(n)}
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          <div className="who-add">
            <input
              ref={inputRef}
              type="text"
              placeholder="اسم آخر… مثال: د. سارة الزهراني"
              aria-label="اسم المعالج"
              autoComplete="off"
              maxLength={80}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTyped();
                }
              }}
            />
            <button type="button" className="btn btn-primary btn-sm" onClick={addTyped}>
              اعتماد
            </button>
          </div>
          <div className="who-hint">
            يُسجَّل هذا الاسم على الجلسات الجديدة فقط ويظهر في التقرير والنشرة.
          </div>
        </div>
      ) : null}
    </div>
  );
}
