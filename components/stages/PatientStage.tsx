"use client";

import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Select } from "@/components/ui/Select";
import { StageHead } from "@/components/ui/StageHead";
import { TextArea } from "@/components/ui/TextArea";
import { CASES, CASE_KEYS, isCaseKey } from "@/lib/data/cases";
import { STAGE_ORDINALS } from "@/lib/data/steps";
import { useSession } from "@/lib/session-store";

export function PatientStage() {
  const { state, dispatch } = useSession();
  const p = state.patient;

  return (
    <>
      <StageHead
        eyebrow={STAGE_ORDINALS[0]}
        title="بيانات المريض"
        description="ابدأ بتعريف الحالة. هذه البيانات تُبنى عليها الجلسة ونشرة المريض والتقرير النهائي."
      />
      <Card>
        <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <Field label="اسم المريض">
            <Input
              type="text"
              placeholder="الاسم الكامل"
              value={p.name}
              onChange={(e) =>
                dispatch({
                  type: "patientField",
                  field: "name",
                  value: e.target.value,
                })
              }
            />
          </Field>
          <Field label="رقم الملف" optional="اختياري">
            <Input
              type="text"
              placeholder="—"
              value={p.file}
              onChange={(e) =>
                dispatch({
                  type: "patientField",
                  field: "file",
                  value: e.target.value,
                })
              }
            />
          </Field>
        </div>

        <div className="grid grid-cols-3 gap-4 max-[900px]:grid-cols-1">
          <Field label="العمر">
            <Input
              type="number"
              placeholder="السنوات"
              value={p.age}
              onChange={(e) =>
                dispatch({
                  type: "patientField",
                  field: "age",
                  value: e.target.value,
                })
              }
            />
          </Field>
          <Field label="الجنس">
            <Segmented
              options={["ذكر", "أنثى"]}
              value={p.sex}
              onChange={(value) =>
                dispatch({ type: "patientField", field: "sex", value })
              }
            />
          </Field>
          <Field label="نوع الحالة" last>
            <Select
              value={p.caseKey}
              onChange={(e) => {
                if (isCaseKey(e.target.value))
                  dispatch({ type: "caseKey", value: e.target.value });
              }}
            >
              {CASE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {CASES[key].label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="الشكوى الرئيسية" last className="mt-[14px]">
          <TextArea
            placeholder="مثال: ألم أسفل الظهر منذ شهر، يزداد مع الجلوس المطوّل."
            value={p.complaint}
            onChange={(e) =>
              dispatch({
                type: "patientField",
                field: "complaint",
                value: e.target.value,
              })
            }
          />
        </Field>
      </Card>
    </>
  );
}
