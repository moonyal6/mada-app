"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/**
 * Replaces the root layout when it fails, so no app styles or fonts load here:
 * inline styles only.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ar" dir="rtl">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "3rem 1.5rem", textAlign: "center" }}>
        <title>حدث خطأ — مدى</title>
        <h1 style={{ fontSize: "1.25rem" }}>حدث خطأ غير متوقع</h1>
        <p>تم إبلاغ الفريق تلقائياً. حاول مرة أخرى.</p>
        <button type="button" onClick={() => unstable_retry()} style={{ padding: "0.5rem 1.25rem" }}>
          إعادة المحاولة
        </button>
      </body>
    </html>
  );
}
