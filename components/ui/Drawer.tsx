"use client";

import type { ReactNode } from "react";

/** The prototype's slide-in form drawer + scrim. */
export function Drawer({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className={`scrim${open ? " show" : ""}`} onClick={onClose} />
      <div className={`drawer${open ? " show" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose} aria-label="إغلاق">
            ×
          </button>
        </div>
        <div className="drawer-body">{open ? children : null}</div>
      </div>
    </>
  );
}
