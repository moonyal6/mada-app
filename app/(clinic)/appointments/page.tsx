"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { Icon } from "@/components/icons";
import { Drawer } from "@/components/ui/Drawer";
import { Empty, StatusBadge } from "@/components/ui/bits";
import { AppointmentForm } from "@/components/forms/AppointmentForm";
import { useNavRefresh } from "@/components/layout/nav-refresh";
import type { Appointment, Patient } from "@/lib/types";

const COLS = { gridTemplateColumns: "70px 1fr 90px 110px 120px" };

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function AppointmentsPage() {
  const [date, setDate] = useState(localToday());
  const [list, setList] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [drawer, setDrawer] = useState(false);
  const refreshNav = useNavRefresh();

  const load = useCallback((d: string) => {
    apiGet<{ appointments: Appointment[] }>(`/api/appointments?date=${d}`)
      .then((r) => setList(r.appointments))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load(date);
  }, [date, load]);

  useEffect(() => {
    apiGet<{ patients: Patient[] }>("/api/patients")
      .then((r) => setPatients(r.patients))
      .catch(() => {});
  }, []);

  const byId = new Map(patients.map((p) => [p.id, p]));

  const setStatus = async (id: string, status: string) => {
    await apiSend(`/api/appointments/${id}`, "PATCH", { status }).catch(() => {});
    load(date);
    refreshNav();
  };

  return (
    <>
      <div className="toolbar">
        <div className="field last" style={{ flex: "0 0 auto" }}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setDrawer(true)}>
          <Icon name="plus" /> موعد جديد
        </button>
      </div>
      <div className="tbl">
        <div className="tbl-row head" style={COLS}>
          <span>الوقت</span>
          <span>المريض</span>
          <span>النوع</span>
          <span>الحالة</span>
          <span>إجراء</span>
        </div>
        {list.length ? (
          list.map((a) => {
            const p = byId.get(a.patientId);
            return (
              <div className="tbl-row" style={COLS} key={a.id}>
                <span className="nm">{toAr(a.time)}</span>
                <span>
                  <span className="nm">{p?.name ?? "—"}</span>
                  <br />
                  <span className="meta">{p?.phone ?? ""}</span>
                </span>
                <span>
                  <span className="badge grey">{a.type}</span>
                </span>
                <span>
                  <StatusBadge status={a.status} />
                </span>
                <span className="cell-actions">
                  {a.status === "محجوز" ? (
                    <button className="btn btn-soft btn-sm" onClick={() => setStatus(a.id, "حضر")}>
                      حضر
                    </button>
                  ) : null}
                  <button className="btn btn-ghost btn-sm" onClick={() => setStatus(a.id, "ملغى")}>
                    إلغاء
                  </button>
                </span>
              </div>
            );
          })
        ) : (
          <Empty icon="appointments">لا مواعيد في هذا اليوم.</Empty>
        )}
      </div>
      <Drawer title="موعد جديد" open={drawer} onClose={() => setDrawer(false)}>
        <AppointmentForm
          patients={patients}
          initialDate={date}
          onSaved={(a) => {
            setDrawer(false);
            setDate(a.date);
            load(a.date);
            refreshNav();
          }}
        />
      </Drawer>
    </>
  );
}
