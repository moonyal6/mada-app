/** Latin digits -> Arabic-Indic digits. Port of the MVP's toAr(). */
export function toAr(n: string | number): string {
  return String(n).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
}

/** Arabic-Indic digits -> Latin digits. Used to re-hydrate the custom
 *  session-count input from the stored value ("٥ جلسة" -> "5"). */
export function fromAr(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}
