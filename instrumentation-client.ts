import * as Sentry from "@sentry/nextjs";
import { privacyOptions } from "@/lib/sentry";

// Inlined at build time, so it must be set when `next build` runs. The
// release is injected by the build plugin from the same commit SHA the
// server uses.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    ...privacyOptions,
  });
}

// Tracing is off, so this records nothing; exporting it silences the SDK's
// build-time "ACTION REQUIRED" warning.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
