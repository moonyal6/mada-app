"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { caseLabel } from "@/lib/format";
import { Icon } from "@/components/icons";
import { Drawer } from "@/components/ui/Drawer";
import { Empty, StatusBadge } from "@/components/ui/bits";
import { PatientForm } from "@/components/forms/PatientForm";
import { useNavRefresh } from "@/components/layout/nav-refresh";
import type { Patient } from "@/lib/types";

const COLS = { gridTemplateColumns: "1fr 130px 140px 100px 90px" };

export default function PatientsPage() {
  const router = useRouter();
  const [patients, setPatients] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const refreshNav = useNavRefresh();

  useEffect(() => {
    apiGet<{ patients: Patient[] }>("/api/patients")
      .then((r) => setPatients(r.patients))
      .catch(() => {});
  }, []);

  const q = query.trim();
  const list = patients.filter(
    (p) =>
      !q ||
      p.name.includes(q) ||
      (p.phone || "").includes(q) ||
      (p.fileNo || "").includes(q),
  );

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input
            type="text"
            placeholder="بحث بالاسم أو الجوال أو رقم الملف…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="btn btn-primary" onClick={() => setDrawer(true)}>
          <Icon name="plus" /> مريض جديد
        </button>
      </div>
      <div className="tbl">
        <div className="tbl-row head" style={COLS}>
          <span>الاسم</span>
          <span>الجوال</span>
          <span>الحالة</span>
          <span>الوضع</span>
          <span>الملف</span>
        </div>
        {list.length ? (
          list.map((p) => (
            <div
              className="tbl-row clickable"
              style={COLS}
              key={p.id}
              onClick={() => router.push(`/patients/${p.id}`)}
            >
              <span>
                <span className="nm">{p.name}</span>
                <br />
                <span className="meta">
                  {p.age ? `${toAr(p.age)} سنة · ` : ""}
                  {p.sex || ""}
                </span>
              </span>
              <span className="meta">{p.phone || "—"}</span>
              <span className="meta">{caseLabel(p.caseKey)}</span>
              <span>
                <StatusBadge status={p.status} />
              </span>
              <span className="meta">#{toAr(p.fileNo || "")}</span>
            </div>
          ))
        ) : (
          <Empty icon="patients">لا مرضى مطابقون.</Empty>
        )}
      </div>
      <Drawer title="مريض جديد" open={drawer} onClose={() => setDrawer(false)}>
        <PatientForm
          onSaved={(p) => {
            setDrawer(false);
            refreshNav();
            router.push(`/patients/${p.id}`);
          }}
        />
      </Drawer>
    </>
  );
}
