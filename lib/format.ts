import { toAr } from "./arabic";
import { CASES, isCaseKey } from "./data/cases";

/** Gregorian date rendered in Arabic — the prototype's fmtDate. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso + "T00:00:00").toLocaleDateString("ar-SA-u-ca-gregory", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function money(n: number): string {
  return toAr(n) + " ر.س";
}

export function caseLabel(key: string): string {
  return isCaseKey(key) ? CASES[key].label : "—";
}

/** Status → badge color class, verbatim from the prototype's statusBadge. */
export const STATUS_BADGE: Record<string, string> = {
  "نشط": "green",
  "متابعة": "blue",
  "منتهٍ": "grey",
  "محجوز": "gold",
  "حضر": "green",
  "ملغى": "red",
};
