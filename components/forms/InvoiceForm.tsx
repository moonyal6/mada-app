"use client";

import { useState } from "react";
import { apiSend } from "@/lib/api";
import { useToast } from "@/components/ui/ToastProvider";
import { Seg } from "@/components/ui/bits";
import type { Invoice, Patient } from "@/lib/types";

export function InvoiceForm({
  patients,
  initialPatientId,
  onSaved,
}: {
  patients: Patient[];
  initialPatientId?: string;
  onSaved: (i: Invoice) => void;
}) {
  const toast = useToast();
  const [patientId, setPatientId] = useState(initialPatientId ?? patients[0]?.id ?? "");
  const [desc, setDesc] = useState("جلسة علاج طبيعي");
  const [amount, setAmount] = useState("300");
  const [paid, setPaid] = useState("مدفوعة");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!patientId) return;
    setBusy(true);
    try {
      const { invoice } = await apiSend<{ invoice: Invoice }>(
        "/api/invoices",
        "POST",
        { patientId, desc, amount: Number(amount) || 0, paid: paid === "مدفوعة" },
      );
      toast("حُفظت الفاتورة");
      onSaved(invoice);
    } catch {
      toast("تعذّر حفظ الفاتورة");
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
      <div className="field">
        <label>البند</label>
        <input type="text" value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="field">
        <label>المبلغ (ر.س)</label>
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div className="field">
        <label>الحالة</label>
        <Seg options={["مدفوعة", "غير مدفوعة"]} value={paid} onChange={setPaid} />
      </div>
      <button className="btn btn-primary btn-block" onClick={save} disabled={busy}>
        حفظ الفاتورة
      </button>
    </>
  );
}
