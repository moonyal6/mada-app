"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Icon, type IconName } from "@/components/icons";
import { NavRefreshContext } from "./nav-refresh";
import { toAr } from "@/lib/arabic";
import { apiGet } from "@/lib/api";

const NAV: { key: string; href: string; label: string; icon: IconName }[] = [
  { key: "dashboard", href: "/dashboard", label: "لوحة موجزة", icon: "dashboard" },
  { key: "appointments", href: "/appointments", label: "المواعيد والاستقبال", icon: "appointments" },
  { key: "patients", href: "/patients", label: "سجل المرضى", icon: "patients" },
  { key: "session", href: "/session", label: "الجلسة السريرية", icon: "session" },
  { key: "followup", href: "/followup", label: "المتابعة والالتزام", icon: "followup" },
  { key: "billing", href: "/billing", label: "الفوترة والمدفوعات", icon: "billing" },
  { key: "inventory", href: "/inventory", label: "المخزون", icon: "inventory" },
];

const SUBTITLE: Record<string, string> = {
  dashboard: "نظرة سريعة على العيادة اليوم",
  appointments: "جدولة المواعيد والاستقبال",
  patients: "ملفات المرضى وتاريخهم",
  session: "التقييم والخطة والتقرير والنشرة",
  followup: "حالة المرضى والتزامهم بالتمارين",
  billing: "فواتير المرضى والمدفوعات",
  inventory: "أصناف العيادة وتنبيهات النقص",
};

type Counts = { patients: number; apptsToday: number; lowStock: number };

export function ClinicShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);

  const moduleKey =
    NAV.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"))
      ?.key ?? "dashboard";
  const active = NAV.find((n) => n.key === moduleKey)!;

  const refreshNav = useCallback(() => {
    apiGet<{ counts: Counts }>("/api/dashboard")
      .then((d) => setCounts(d.counts))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshNav();
  }, [pathname, refreshNav]);

  const countFor = (key: string): string => {
    if (!counts) return "";
    if (key === "appointments" && counts.apptsToday > 0) return toAr(counts.apptsToday);
    if (key === "patients") return toAr(counts.patients);
    if (key === "inventory" && counts.lowStock > 0) return toAr(counts.lowStock);
    return "";
  };

  return (
    <NavRefreshContext.Provider value={refreshNav}>
      <div className="app">
        <aside className={`side${menuOpen ? " show" : ""}`}>
          <div className="brand">
            <span className="mark">
              <BrandMark />
            </span>
            <div className="name">
              مدى <small>نظام إدارة العيادة</small>
            </div>
          </div>
          <nav className="nav">
            {NAV.map((n) => {
              const count = countFor(n.key);
              return (
                <Link
                  key={n.key}
                  href={n.href}
                  className={`nav-item${n.key === moduleKey ? " on" : ""}`}
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                  {count !== "" ? <span className="count">{count}</span> : null}
                </Link>
              );
            })}
          </nav>
          <div className="side-foot">
            <span className="av">عت</span>
            <div>
              د. عبدالرحمن التركي
              <br />
              <span style={{ fontSize: 11 }}>عيادة العلاج الطبيعي</span>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <button
              className="menu-btn"
              aria-label="القائمة"
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Icon name="menu" size={18} />
            </button>
            <div>
              <h1>{active.label}</h1>
              <div className="sub">{SUBTITLE[active.key] ?? ""}</div>
            </div>
            <div className="spacer" />
            <span className="chip">نسخة تجريبية</span>
          </header>
          <div className="view">{children}</div>
        </div>
      </div>
      {menuOpen ? (
        <div className="scrim show" onClick={() => setMenuOpen(false)} />
      ) : null}
    </NavRefreshContext.Provider>
  );
}
