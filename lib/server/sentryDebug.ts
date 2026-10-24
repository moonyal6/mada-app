import "server-only";

/** The throw routes exist only while `SENTRY_DEBUG_ROUTE=1` (verification). */
export function sentryDebugEnabled(): boolean {
  return process.env.SENTRY_DEBUG_ROUTE === "1";
}
