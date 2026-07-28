"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { ChipGroup, ChipGroupLabel } from "@/components/ui/ChipGroup";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { StageHead } from "@/components/ui/StageHead";
import { TextArea } from "@/components/ui/TextArea";
import { fromAr, toAr } from "@/lib/arabic";
import { ADVICE_COMMON } from "@/lib/data/advice";
import { DX_SUGGEST } from "@/lib/data/diagnoses";
import {
  FOLLOW_OPTS,
  FREQ_OPTS,
  HOME_OPTS,
  PAIN_OPTS,
  SESSION_OPTS,
} from "@/lib/data/options";
import { STAGE_ORDINALS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";
import type { DoctorOpinion } from "@/lib/types";

/** Recovers the free-typed session count from the stored value ("٥ جلسة"). */
function deriveSessionCustom(sessions: string): string {
  const match = /^([٠-٩]+) جلسة$/.exec(sessions);
  return match ? fromAr(match[1]) : "";
}

export function DoctorOpinionStage() {
  const { state, dispatch } = useSession();
  const d = state.doctor;
  const [sessCustom, setSessCustom] = useState(() =>
    deriveSessionCustom(state.doctor.sessions),
  );

  const set = (field: keyof DoctorOpinion, value: string) =>
    dispatch({ type: "doctorField", field, value });

  /** Chip toggle: clicking the active chip clears the value. */
  const pick = (field: keyof DoctorOpinion, value: string) =>
    set(field, d[field] === value ? "" : value);

  /** Insert chips append their text to the target textarea. */
  const insert = (field: "dx" | "advice", text: string) => {
    const current = d[field];
    set(field, (current.trim() ? current.trim() + "\n" : "") + text);
  };

  return (
    <>
      <StageHead
        eyebrow={STAGE_ORDINALS[2]}
        title="رأي الطبيب المعتمد"
        description="اختر بنقرة واحدة قدر المستطاع. الخيارات تختصر الوقت، وتظل حرّاً في الكتابة أو التعديل. قرارك هو أساس التقرير — المنصّة تنظّم ولا تغيّر."
      />
      <Card>
        <Field label="التشخيص المعتمد">
          <TextArea
            placeholder="مثال: آلام أسفل الظهر الميكانيكية، دون اعتلال جذري."
            value={d.dx}
            onChange={(e) => set("dx", e.target.value)}
          />
          <ChipGroupLabel>تشخيصات شائعة لهذه الحالة — انقر للإدراج:</ChipGroupLabel>
          <ChipGroup>
            {DX_SUGGEST[state.patient.caseKey].map((option) => (
              <Chip
                key={option}
                mode="insert"
                onClick={() => insert("dx", option)}
              >
                {option}
              </Chip>
            ))}
          </ChipGroup>
        </Field>

        <div className="mt-1.5 grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          <Field label="تاريخ الجلسة">
            <Input
              type="date"
              value={d.date}
              onChange={(e) => set("date", e.target.value)}
            />
          </Field>

          <Field label="عدد الجلسات">
            <ChipGroup>
              {SESSION_OPTS.map((option) => (
                <Chip
                  key={option}
                  on={d.sessions === option}
                  onClick={() => {
                    setSessCustom("");
                    pick("sessions", option);
                  }}
                >
                  {option}
                </Chip>
              ))}
            </ChipGroup>
            <div className="ms-2 inline-flex items-center gap-1.5 text-[12.5px] text-muted">
              أو أدخل رقماً:{" "}
              <Input
                type="number"
                min="1"
                placeholder="—"
                className="w-16 px-2 py-1.5"
                value={sessCustom}
                onChange={(e) => {
                  setSessCustom(e.target.value);
                  set(
                    "sessions",
                    e.target.value ? toAr(e.target.value) + " جلسة" : "",
                  );
                }}
              />
            </div>
          </Field>

          <Field label="التكرار الأسبوعي">
            <ChipGroup>
              {FREQ_OPTS.map((option) => (
                <Chip
                  key={option}
                  on={d.frequency === option}
                  onClick={() => pick("frequency", option)}
                >
                  {option}
                </Chip>
              ))}
            </ChipGroup>
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          <Field label="البرنامج المنزلي">
            <ChipGroup>
              {HOME_OPTS.map((option) => (
                <Chip
                  key={option}
                  on={d.home === option}
                  onClick={() => pick("home", option)}
                >
                  {option}
                </Chip>
              ))}
            </ChipGroup>
          </Field>

          <Field label="المتابعة">
            <ChipGroup>
              {FOLLOW_OPTS.map((option) => (
                <Chip
                  key={option}
                  on={d.follow === option}
                  onClick={() => pick("follow", option)}
                >
                  {option}
                </Chip>
              ))}
            </ChipGroup>
          </Field>

          <Field label="شدة الألم" optional="0–10">
            <ChipGroup>
              {PAIN_OPTS.map((value) => {
                const stored = `${toAr(value)} / ١٠`;
                return (
                  <Chip
                    key={value}
                    mode="num"
                    on={d.pain === stored}
                    onClick={() => pick("pain", stored)}
                  >
                    {toAr(value)}
                  </Chip>
                );
              })}
            </ChipGroup>
          </Field>
        </div>

        <Field label="نصائح وإرشادات للمريض" className="mt-1.5">
          <ChipGroupLabel>نصائح جاهزة — انقر لإضافتها:</ChipGroupLabel>
          <ChipGroup>
            {ADVICE_COMMON.map((option) => (
              <Chip
                key={option}
                mode="insert"
                onClick={() => insert("advice", option)}
              >
                {option}
              </Chip>
            ))}
          </ChipGroup>
          <TextArea
            className="mt-2.5"
            placeholder="تُضاف النصائح المختارة هنا، ويمكنك تعديلها أو الكتابة بحرّية."
            value={d.advice}
            onChange={(e) => set("advice", e.target.value)}
          />
        </Field>

        <Field label="ملاحظات إضافية على الخطة" optional="اختياري" last>
          <TextArea
            placeholder="أي تفاصيل أخرى في خطة العلاج."
            value={d.planNotes}
            onChange={(e) => set("planNotes", e.target.value)}
          />
        </Field>
      </Card>
    </>
  );
}
