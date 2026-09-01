"use client";

import { useState } from "react";
import { CASES, CASE_KEYS } from "@/lib/data/cases";
import { apiSend } from "@/lib/api";
import { useToast } from "@/components/ui/ToastProvider";
import { Seg } from "@/components/ui/bits";
import type { Patient } from "@/lib/types";

export function PatientForm({ onSaved }: { onSaved: (p: Patient) => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [fileNo, setFileNo] = useState("");
  const [age, setAge] = useState("");
  const [sex, setSex] = useState("ذكر");
  const [caseKey, setCaseKey] = useState<string>(CASE_KEYS[0]);
  const [complaint, setComplaint] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) {
      toast("أدخل اسم المريض");
      return;
    }
    setBusy(true);
    try {
      const { patient } = await apiSend<{ patient: Patient }>(
        "/api/patients",
        "POST",
        {
          name,
          phone,
          fileNo,
          age: Number(age) || undefined,
          sex,
          caseKey,
          complaint,
        },
      );
      toast("أُضيف المريض");
      onSaved(patient);
    } catch {
      toast("تعذّر حفظ المريض");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="field">
        <label>الاسم الكامل</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid2">
        <div className="field">
          <label>الجوال</label>
          <input type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="field">
          <label>
            رقم الملف <span className="opt">اختياري</span>
          </label>
          <input type="text" value={fileNo} onChange={(e) => setFileNo(e.target.value)} />
        </div>
      </div>
      <div className="grid2">
        <div className="field">
          <label>العمر</label>
          <input type="number" value={age} onChange={(e) => setAge(e.target.value)} />
        </div>
        <div className="field">
          <label>الجنس</label>
          <Seg options={["ذكر", "أنثى"]} value={sex} onChange={setSex} />
        </div>
      </div>
      <div className="field">
        <label>نوع الحالة</label>
        <select value={caseKey} onChange={(e) => setCaseKey(e.target.value)}>
          {CASE_KEYS.map((k) => (
            <option key={k} value={k}>
              {CASES[k].label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>الشكوى الرئيسية</label>
        <textarea value={complaint} onChange={(e) => setComplaint(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-block" onClick={save} disabled={busy}>
        حفظ المريض
      </button>
    </>
  );
}
