"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { caseLabel, fmtDate, money } from "@/lib/format";
import { Icon } from "@/components/icons";
import { Drawer } from "@/components/ui/Drawer";
import { Empty, StatusBadge } from "@/components/ui/bits";
import { AppointmentForm } from "@/components/forms/AppointmentForm";
import { InvoiceForm } from "@/components/forms/InvoiceForm";
import { useNavRefresh } from "@/components/layout/nav-refresh";
import { useToast } from "@/components/ui/ToastProvider";
import type {
  AdherenceSummary,
  Appointment,
  ClinicalSession,
  Invoice,
  Patient,
} from "@/lib/types";

type Detail = {
  patient: Patient;
  appointments: Appointment[];
  sessions: ClinicalSession[];
  invoices: Invoice[];
  adherence: AdherenceSummary;
};

export default function PatientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const refreshNav = useNavRefresh();
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [drawer, setDrawer] = useState<"appt" | "invoice" | null>(null);
  const [allPatients, setAllPatients] = useState<Patient[]>([]);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => {
    apiGet<Detail>(`/api/patients/${id}`)
      .then(setData)
      .catch(() => setMissing(true));
  }, [id]);

  useEffect(load, [load]);
  useEffect(() => {
    apiGet<{ patients: Patient[] }>("/api/patients")
      .then((r) => setAllPatients(r.patients))
      .catch(() => {});
  }, []);

  if (missing) {
    return (
      <div className="card">
        <Empty icon="patients">
          المريض غير موجود.
          <div style={{ marginTop: 14 }}>
            <Link href="/patients" className="btn btn-primary btn-sm">
              فتح سجل المرضى
            </Link>
          </div>
        </Empty>
      </div>
    );
  }
  if (!data) return null;

  const { patient: p, appointments, sessions, invoices, adherence } = data;
  const draft = sessions.find((s) => s.status === "draft");

  const startSession = async () => {
    setStarting(true);
    try {
      const { session } = await apiSend<{ session: ClinicalSession }>(
        "/api/sessions",
        "POST",
        { patientId: p.id },
      );
      router.push(`/session?id=${session.id}`);
    } catch {
      toast("تعذّر بدء الجلسة");
      setStarting(false);
    }
  };

  const today = new Date();
  const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <>
      <Link href="/patients" className="btn btn-ghost btn-sm" style={{ marginBottom: 16 }}>
        → رجوع لسجل المرضى
      </Link>
      <div className="grid2">
        <div>
          <div className="card">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
              <h3 style={{ margin: 0 }}>{p.name}</h3>
              <StatusBadge status={p.status} />
            </div>
            <div className="info-row">
              <span className="k">الجوال</span>
              <span className="v">{p.phone || "—"}</span>
            </div>
            <div className="info-row">
              <span className="k">العمر / الجنس</span>
              <span className="v">
                {p.age ? toAr(p.age) : "—"} · {p.sex || "—"}
              </span>
            </div>
            <div className="info-row">
              <span className="k">رقم الملف</span>
              <span className="v">#{toAr(p.fileNo || "—")}</span>
            </div>
            <div className="info-row">
              <span className="k">نوع الحالة</span>
              <span className="v">{caseLabel(p.caseKey)}</span>
            </div>
            <div className="info-row">
              <span className="k">الشكوى</span>
              <span className="v">{p.complaint || "—"}</span>
            </div>
            <div className="info-row">
              <span className="k">الالتزام</span>
              <span className="v">
                {adherence.pct == null ? "—" : `${toAr(adherence.pct)}٪`}
                {adherence.lastPain != null ? (
                  <span className="meta" style={{ marginInlineStart: 8 }}>
                    آخر ألم مسجّل: {toAr(adherence.lastPain)}/١٠
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          {draft ? (
            <button
              className="btn btn-gold btn-block"
              onClick={() => router.push(`/session?id=${draft.id}`)}
            >
              <Icon name="session" /> متابعة الجلسة الجارية (مسودّة)
            </button>
          ) : null}
          <button
            className="btn btn-primary btn-block"
            style={draft ? { marginTop: 10 } : undefined}
            onClick={startSession}
            disabled={starting}
          >
            <Icon name="session" /> بدء جلسة سريرية
          </button>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost btn-sm btn-block" onClick={() => setDrawer("appt")}>
              موعد جديد
            </button>
            <button className="btn btn-ghost btn-sm btn-block" onClick={() => setDrawer("invoice")}>
              فاتورة جديدة
            </button>
          </div>
        </div>
        <div>
          <div className="card">
            <h3>الجلسات السابقة</h3>
            {sessions.length ? (
              sessions.map((s) => (
                <div
                  className="info-row"
                  key={s.id}
                  style={s.status === "draft" ? { cursor: "pointer" } : undefined}
                  onClick={
                    s.status === "draft"
                      ? () => router.push(`/session?id=${s.id}`)
                      : undefined
                  }
                >
                  <span className="k">{fmtDate(s.date)}</span>
                  <span className="v" style={{ flex: 1 }}>
                    {s.dx || "جلسة"}
                  </span>
                  {s.status === "draft" ? (
                    <span className="badge gold">مسودّة</span>
                  ) : s.sealed ? (
                    <span className="badge green">معتمد</span>
                  ) : (
                    <span className="badge grey">منتهية</span>
                  )}
                </div>
              ))
            ) : (
              <Empty padding={18}>لا جلسات سابقة.</Empty>
            )}
          </div>
          <div className="card">
            <h3>المواعيد</h3>
            {appointments.length ? (
              appointments.slice(0, 5).map((a) => (
                <div className="info-row" key={a.id}>
                  <span className="k">{fmtDate(a.date)}</span>
                  <span className="v" style={{ flex: 1 }}>
                    {toAr(a.time)} · {a.type}
                  </span>
                  <StatusBadge status={a.status} />
                </div>
              ))
            ) : (
              <Empty padding={18}>لا مواعيد.</Empty>
            )}
          </div>
          <div className="card">
            <h3>الفواتير</h3>
            {invoices.length ? (
              invoices.map((i) => (
                <div className="info-row" key={i.id}>
                  <span className="k">{fmtDate(i.date)}</span>
                  <span className="v" style={{ flex: 1 }}>
                    {money(i.total)}
                  </span>
                  {i.paid ? (
                    <span className="badge green">مدفوعة</span>
                  ) : (
                    <span className="badge red">غير مدفوعة</span>
                  )}
                </div>
              ))
            ) : (
              <Empty padding={18}>لا فواتير.</Empty>
            )}
          </div>
        </div>
      </div>

      <Drawer title="موعد جديد" open={drawer === "appt"} onClose={() => setDrawer(null)}>
        <AppointmentForm
          patients={allPatients.length ? allPatients : [p]}
          initialPatientId={p.id}
          initialDate={localToday}
          onSaved={() => {
            setDrawer(null);
            load();
            refreshNav();
          }}
        />
      </Drawer>
      <Drawer title="فاتورة جديدة" open={drawer === "invoice"} onClose={() => setDrawer(null)}>
        <InvoiceForm
          patients={allPatients.length ? allPatients : [p]}
          initialPatientId={p.id}
          onSaved={() => {
            setDrawer(null);
            load();
            refreshNav();
          }}
        />
      </Drawer>
    </>
  );
}
