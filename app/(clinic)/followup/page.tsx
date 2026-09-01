"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { caseLabel } from "@/lib/format";
import { Empty, StatusBadge } from "@/components/ui/bits";
import type { AdherenceSummary, Patient } from "@/lib/types";

const COLS = { gridTemplateColumns: "1fr 130px 130px 120px" };

export default function FollowupPage() {
  const router = useRouter();
  const [rows, setRows] = useState<
    { patient: Patient; adherence: AdherenceSummary }[] | null
  >(null);

  useEffect(() => {
    apiGet<{ rows: { patient: Patient; adherence: AdherenceSummary }[] }>(
      "/api/followup",
    )
      .then((r) => setRows(r.rows))
      .catch(() => {});
  }, []);

  if (!rows) return null;

  return (
    <>
      <div className="tbl">
        <div className="tbl-row head" style={COLS}>
          <span>المريض</span>
          <span>الحالة</span>
          <span>الوضع</span>
          <span>الالتزام</span>
        </div>
        {rows.length ? (
          rows.map(({ patient: p, adherence }) => {
            const pct = adherence.pct;
            return (
              <div
                className="tbl-row clickable"
                style={COLS}
                key={p.id}
                onClick={() => router.push(`/patients/${p.id}`)}
              >
                <span>
                  <span className="nm">{p.name}</span>
                  {adherence.lastPain != null ? (
                    <>
                      <br />
                      <span className="meta">
                        آخر ألم مسجّل: {toAr(adherence.lastPain)}/١٠
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="meta">{caseLabel(p.caseKey)}</span>
                <span>
                  <StatusBadge status={p.status} />
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {pct == null ? (
                    <span className="meta">—</span>
                  ) : (
                    <>
                      <span
                        style={{
                          background: "var(--line-2)",
                          borderRadius: 100,
                          height: 8,
                          overflow: "hidden",
                          width: 90,
                          display: "inline-block",
                        }}
                      >
                        <span
                          style={{
                            display: "block",
                            height: "100%",
                            width: `${pct}%`,
                            background:
                              pct >= 70
                                ? "var(--ok)"
                                : pct >= 40
                                  ? "var(--gold)"
                                  : "var(--danger)",
                          }}
                        />
                      </span>
                      <span className="meta">{toAr(pct)}٪</span>
                    </>
                  )}
                </span>
              </div>
            );
          })
        ) : (
          <Empty>لا مرضى تحت المتابعة.</Empty>
        )}
      </div>
      <p className="sub" style={{ marginTop: 14, color: "var(--muted)", fontSize: 13 }}>
        النسبة تُحسب من تسجيل المريض الفعلي في نشرته (آخر ٧ أيام). تنبيه المريض
        التلقائي عند عدم أداء التمارين ضمن مزايا بوّابة المريض المؤجّلة للمرحلة
        اللاحقة.
      </p>
    </>
  );
}
