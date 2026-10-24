import * as Sentry from "@sentry/nextjs";
import { privacyOptions } from "@/lib/sentry";

// Without a DSN (dev, tests, CI) the SDK is never initialised at all.
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    release: process.env.RAILWAY_GIT_COMMIT_SHA,
    environment: process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV,
    ...privacyOptions,
  });
}
