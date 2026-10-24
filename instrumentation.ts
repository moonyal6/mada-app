import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Node only: every route here runs on the Node runtime; Edge is not set up.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
