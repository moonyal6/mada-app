"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { fmtDate, money } from "@/lib/format";
import { Icon } from "@/components/icons";
import { Drawer } from "@/components/ui/Drawer";
import { Empty } from "@/components/ui/bits";
import { InvoiceForm } from "@/components/forms/InvoiceForm";
import type { Invoice, Patient } from "@/lib/types";

const COLS = { gridTemplateColumns: "1fr 130px 110px 110px 110px" };

export default function BillingPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [drawer, setDrawer] = useState(false);

  const load = useCallback(() => {
    apiGet<{ invoices: Invoice[] }>("/api/invoices")
      .then((r) => setInvoices(r.invoices))
      .catch(() => {});
  }, []);

  useEffect(load, [load]);
  useEffect(() => {
    apiGet<{ patients: Patient[] }>("/api/patients")
      .then((r) => setPatients(r.patients))
      .catch(() => {});
  }, []);

  const byId = new Map(patients.map((p) => [p.id, p]));
  const income = invoices.filter((i) => i.paid).reduce((s, i) => s + i.total, 0);
  const due = invoices.filter((i) => !i.paid).reduce((s, i) => s + i.total, 0);

  const markPaid = async (id: string) => {
    await apiSend(`/api/invoices/${id}`, "PATCH", { paid: true }).catch(() => {});
    load();
  };

  return (
    <>
      <div className="statgrid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <div className="stat">
          <div className="v">{money(income)}</div>
          <div className="l">محصّل</div>
        </div>
        <div className="stat">
          <div className="v">{money(due)}</div>
          <div className="l">مستحق</div>
        </div>
        <div className="stat">
          <div className="v">{toAr(invoices.length)}</div>
          <div className="l">إجمالي الفواتير</div>
        </div>
      </div>
      <div className="toolbar">
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setDrawer(true)}>
          <Icon name="plus" /> فاتورة جديدة
        </button>
      </div>
      <div className="tbl">
        <div className="tbl-row head" style={COLS}>
          <span>المريض</span>
          <span>التاريخ</span>
          <span>المبلغ</span>
          <span>الحالة</span>
          <span>إجراء</span>
        </div>
        {invoices.length ? (
          invoices.map((i) => {
            const p = byId.get(i.patientId);
            return (
              <div className="tbl-row" style={COLS} key={i.id}>
                <span>
                  <span className="nm">{p?.name ?? "—"}</span>
                  <br />
                  <span className="meta">{i.items.map((x) => x.desc).join("، ")}</span>
                </span>
                <span className="meta">{fmtDate(i.date)}</span>
                <span className="nm">{money(i.total)}</span>
                <span>
                  {i.paid ? (
                    <span className="badge green">مدفوعة</span>
                  ) : (
                    <span className="badge red">غير مدفوعة</span>
                  )}
                </span>
                <span className="cell-actions">
                  {i.paid ? null : (
                    <button className="btn btn-soft btn-sm" onClick={() => markPaid(i.id)}>
                      تحصيل
                    </button>
                  )}
                </span>
              </div>
            );
          })
        ) : (
          <Empty icon="billing">لا فواتير بعد.</Empty>
        )}
      </div>
      <Drawer title="فاتورة جديدة" open={drawer} onClose={() => setDrawer(false)}>
        <InvoiceForm
          patients={patients}
          onSaved={() => {
            setDrawer(false);
            load();
          }}
        />
      </Drawer>
    </>
  );
}
