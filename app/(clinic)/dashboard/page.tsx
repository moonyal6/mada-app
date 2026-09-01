"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { fmtDate, money } from "@/lib/format";
import { Icon, type IconName } from "@/components/icons";
import { Empty, StatusBadge } from "@/components/ui/bits";
import type { Appointment, InventoryItem, Patient } from "@/lib/types";

type Dash = {
  today: string;
  patients: Patient[];
  todaysAppts: Appointment[];
  sessionsCount: number;
  income: number;
  lowStock: InventoryItem[];
};

function Stat({
  icon,
  color,
  fill,
  value,
  label,
}: {
  icon: IconName;
  color: string;
  fill: string;
  value: string;
  label: string;
}) {
  return (
    <div className="stat">
      <div className="ic" style={{ background: fill, color }}>
        <Icon name={icon} />
      </div>
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<Dash | null>(null);

  useEffect(() => {
    apiGet<Dash>("/api/dashboard").then(setData).catch(() => {});
  }, []);

  if (!data) return null;

  const byId = new Map(data.patients.map((p) => [p.id, p]));
  const appts = [...data.todaysAppts].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <>
      <div className="statgrid">
        <Stat icon="patients" color="#1B5E56" fill="#DCEAE6" value={toAr(data.patients.length)} label="إجمالي المرضى" />
        <Stat icon="appointments" color="#2A6F97" fill="#DCEAF2" value={toAr(data.todaysAppts.length)} label="مواعيد اليوم" />
        <Stat icon="followup" color="#B4893D" fill="#F4EAD3" value={toAr(data.sessionsCount)} label="الجلسات المسجّلة" />
        <Stat icon="billing" color="#1B6E52" fill="#DDEEE6" value={money(data.income)} label="الدخل المُحصّل" />
      </div>
      <div className="grid2">
        <div className="card">
          <h3>مواعيد اليوم</h3>
          <p className="sub">{fmtDate(data.today)}</p>
          {appts.length ? (
            appts.map((a) => {
              const p = byId.get(a.patientId);
              return (
                <div className="info-row" key={a.id}>
                  <span className="v" style={{ minWidth: 56 }}>
                    {toAr(a.time)}
                  </span>
                  <span style={{ flex: 1 }}>
                    {p?.name ?? "—"}{" "}
                    <span className="badge grey" style={{ marginInlineStart: 6 }}>
                      {a.type}
                    </span>
                  </span>
                  <StatusBadge status={a.status} />
                </div>
              );
            })
          ) : (
            <Empty padding={22}>لا مواعيد اليوم.</Empty>
          )}
          <Link href="/appointments" className="btn btn-soft btn-sm" style={{ marginTop: 12 }}>
            إدارة المواعيد
          </Link>
        </div>
        <div className="card">
          <h3>تنبيهات المخزون</h3>
          <p className="sub">أصناف بلغت حدّ النقص</p>
          {data.lowStock.length ? (
            data.lowStock.map((i) => (
              <div className="info-row" key={i.id}>
                <span style={{ flex: 1 }}>{i.name}</span>
                <span className="badge red">
                  {toAr(i.qty)} / {toAr(i.min)} {i.unit}
                </span>
              </div>
            ))
          ) : (
            <Empty padding={22}>المخزون ضمن الحدّ الآمن.</Empty>
          )}
          <Link href="/inventory" className="btn btn-soft btn-sm" style={{ marginTop: 12 }}>
            إدارة المخزون
          </Link>
        </div>
      </div>
    </>
  );
}
