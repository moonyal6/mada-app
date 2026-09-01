"use client";

import type { ReactNode } from "react";
import { STATUS_BADGE } from "@/lib/format";
import { Icon, type IconName } from "@/components/icons";

/** Status pill with dot — the prototype's statusBadge(). */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_BADGE[status] ?? "grey"}`}>
      <span className="dot" />
      {status}
    </span>
  );
}

export function Empty({
  icon,
  children,
  padding,
}: {
  icon?: IconName;
  children: ReactNode;
  padding?: number;
}) {
  return (
    <div className="empty" style={padding ? { padding } : undefined}>
      {icon ? <Icon name={icon} strokeWidth={1.5} /> : null}
      <div>{children}</div>
    </div>
  );
}

/** Two-option segmented control used inside drawer forms. */
export function Seg({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={value === o ? "on" : ""}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
