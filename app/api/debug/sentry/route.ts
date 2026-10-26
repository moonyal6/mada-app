import { sentryDebugEnabled } from "@/lib/server/sentryDebug";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Throws on purpose so verify/sentry.mjs can see a server error reach Sentry.
 * POST lets the script send a body, cookie and query string that must not
 * appear in the event.
 */
function handler() {
  if (!sentryDebugEnabled()) return new Response("Not found", { status: 404 });
  throw new Error("Sentry verification: deliberate server throw");
}

export { handler as GET, handler as POST };
