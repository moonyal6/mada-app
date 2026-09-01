"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiSend } from "@/lib/api";
import { toAr } from "@/lib/arabic";
import { Icon } from "@/components/icons";
import { Drawer } from "@/components/ui/Drawer";
import { useNavRefresh } from "@/components/layout/nav-refresh";
import { useToast } from "@/components/ui/ToastProvider";
import type { InventoryItem } from "@/lib/types";

const COLS = { gridTemplateColumns: "1fr 110px 110px 160px" };

export default function InventoryPage() {
  const toast = useToast();
  const refreshNav = useNavRefresh();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [drawer, setDrawer] = useState<"new" | "receive" | null>(null);
  const [receiveFor, setReceiveFor] = useState<InventoryItem | null>(null);
  const [receiveQty, setReceiveQty] = useState("10");
  const [form, setForm] = useState({ name: "", qty: "0", min: "5", unit: "قطعة" });

  const load = useCallback(() => {
    apiGet<{ inventory: InventoryItem[] }>("/api/inventory")
      .then((r) => setItems(r.inventory))
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  const sorted = [...items].sort(
    (a, b) => (a.qty <= a.min ? 0 : 1) - (b.qty <= b.min ? 0 : 1),
  );

  const adjust = async (id: string, delta: number) => {
    await apiSend(`/api/inventory/${id}`, "PATCH", { delta }).catch(() => {});
    load();
    refreshNav();
  };

  const saveItem = async () => {
    if (!form.name.trim()) {
      toast("أدخل اسم الصنف");
      return;
    }
    await apiSend("/api/inventory", "POST", {
      name: form.name,
      qty: Number(form.qty) || 0,
      min: Number(form.min) || 0,
      unit: form.unit,
    }).catch(() => {});
    setDrawer(null);
    setForm({ name: "", qty: "0", min: "5", unit: "قطعة" });
    toast("أُضيف الصنف");
    load();
    refreshNav();
  };

  const doReceive = async () => {
    if (!receiveFor) return;
    await adjust(receiveFor.id, Number(receiveQty) || 0);
    setDrawer(null);
    toast("تم التوريد");
  };

  return (
    <>
      <div className="toolbar">
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-primary" onClick={() => setDrawer("new")}>
          <Icon name="plus" /> صنف جديد
        </button>
      </div>
      <div className="tbl">
        <div className="tbl-row head" style={COLS}>
          <span>الصنف</span>
          <span>المتوفّر</span>
          <span>حدّ النقص</span>
          <span>تعديل الكمية</span>
        </div>
        {sorted.map((i) => {
          const low = i.qty <= i.min;
          return (
            <div className="tbl-row" style={COLS} key={i.id}>
              <span>
                <span className="nm">{i.name}</span>{" "}
                {low ? (
                  <span className="badge red" style={{ marginInlineStart: 6 }}>
                    نقص
                  </span>
                ) : null}
              </span>
              <span className="nm">
                {toAr(i.qty)} {i.unit}
              </span>
              <span className="meta">
                {toAr(i.min)} {i.unit}
              </span>
              <span className="cell-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => adjust(i.id, -1)}>
                  −
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => adjust(i.id, 1)}>
                  ＋
                </button>
                <button
                  className="btn btn-soft btn-sm"
                  onClick={() => {
                    setReceiveFor(i);
                    setReceiveQty("10");
                    setDrawer("receive");
                  }}
                >
                  توريد
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <p className="sub" style={{ marginTop: 14, color: "var(--muted)", fontSize: 13 }}>
        أتمتة الطلب (ربط المندوبين والرسائل التلقائية والدفع) ضمن المرحلة اللاحقة.
      </p>

      <Drawer title="صنف مخزون جديد" open={drawer === "new"} onClose={() => setDrawer(null)}>
        <div className="field">
          <label>اسم الصنف</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </div>
        <div className="grid3">
          <div className="field">
            <label>الكمية</label>
            <input
              type="number"
              value={form.qty}
              onChange={(e) => setForm({ ...form, qty: e.target.value })}
            />
          </div>
          <div className="field">
            <label>حدّ النقص</label>
            <input
              type="number"
              value={form.min}
              onChange={(e) => setForm({ ...form, min: e.target.value })}
            />
          </div>
          <div className="field">
            <label>الوحدة</label>
            <input
              type="text"
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
            />
          </div>
        </div>
        <button className="btn btn-primary btn-block" onClick={saveItem}>
          حفظ الصنف
        </button>
      </Drawer>

      <Drawer title="توريد مخزون" open={drawer === "receive"} onClose={() => setDrawer(null)}>
        {receiveFor ? (
          <>
            <p className="sub" style={{ fontSize: 13, color: "var(--muted)", marginBottom: 14 }}>
              {receiveFor.name} — المتوفّر حالياً {toAr(receiveFor.qty)} {receiveFor.unit}
            </p>
            <div className="field">
              <label>الكمية الواردة</label>
              <input
                type="number"
                value={receiveQty}
                onChange={(e) => setReceiveQty(e.target.value)}
              />
            </div>
            <button className="btn btn-primary btn-block" onClick={doReceive}>
              إضافة للمخزون
            </button>
          </>
        ) : null}
      </Drawer>
    </>
  );
}
