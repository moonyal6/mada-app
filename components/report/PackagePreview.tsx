/** `.pkg-preview` — exactly what gets sent for writing, shown to the doctor. */
export function PackagePreview({ pkg }: { pkg: string }) {
  return (
    <div className="mb-[14px] max-h-[240px] overflow-auto rounded-field bg-brand-dark px-[18px] py-4 text-[12.5px] leading-[1.85] whitespace-pre-wrap text-on-dark">
      {pkg}
    </div>
  );
}
