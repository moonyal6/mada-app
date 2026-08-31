"use client";

import { useMemo } from "react";
import qrcode from "qrcode-generator";

/**
 * Renders a QR SVG for `url`. The generated markup is the only place in the
 * codebase that uses dangerouslySetInnerHTML — qrcode-generator hands back an
 * SVG string, and the input is a URL the doctor typed, not model output.
 */
export function QrCode({
  url,
  cellSize,
  margin,
  className,
}: {
  url: string;
  cellSize: number;
  margin: number;
  className?: string;
}) {
  const svg = useMemo(() => {
    if (!url) return null;
    try {
      const qr = qrcode(0, "M");
      qr.addData(url);
      qr.make();
      return qr.createSvgTag({ cellSize, margin });
    } catch {
      return null;
    }
  }, [url, cellSize, margin]);

  if (!svg) return <div className={className} />;
  return <div className={className} dangerouslySetInnerHTML={{ __html: svg }} />;
}
