"use client";

import { useState } from "react";
import { apiSend } from "@/lib/api";
import { useToast } from "@/components/ui/ToastProvider";
import { Seg } from "@/components/ui/bits";
import type { Appointment, Patient } from "@/lib/types";

export function AppointmentForm({
  patients,
  initialPatientId,
  initialDate,
  onSaved,
}: {
  patients: Patient[];
  initialPatientId?: string;
  initialDate: string;
  onSaved: (a: Appointment) => void;
}) {
  const toast = useToast();
  const [patientId, setPatientId] = useState(initialPatientId ?? patients[0]?.id ?? "");
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState("09:00");
  const [type, setType] = useState("كشف");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!patientId) return;
    setBusy(true);
    try {
      const { appointment } = await apiSend<{ appointment: Appointment }>(
        "/api/appointments",
        "POST",
        { patientId, date, time, type },
      );
      toast("حُجز الموعد");
      onSaved(appointment);
    } catch {
      toast("تعذّر حجز الموعد");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="field">
        <label>المريض</label>
        <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid2">
        <div className="field">
          <label>التاريخ</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label>الوقت</label>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>النوع</label>
        <Seg options={["كشف", "متابعة"]} value={type} onChange={setType} />
      </div>
      <button className="btn btn-primary btn-block" onClick={save} disabled={busy}>
        حجز الموعد
      </button>
    </>
  );
}
