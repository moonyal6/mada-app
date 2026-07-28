"use client";

import { usePersistence } from "@/lib/persistence";

/**
 * Visible warning when persistence is degraded (storage unavailable, corrupt
 * data, or a failed write). The session keeps working in memory either way.
 */
export function StorageNotice() {
  const { storageNotice } = usePersistence();
  if (!storageNotice) return null;

  return (
    <div className="no-print mb-[18px] flex items-center gap-2.5 rounded-field border-[1.5px] border-danger bg-danger-soft px-[15px] py-[11px] text-[13px] font-medium text-danger">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="h-[18px] w-[18px] shrink-0"
      >
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" />
      </svg>
      <span>{storageNotice}</span>
    </div>
  );
}
