import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

/**
 * Sentry options shared by the server and the browser. The app holds patient
 * health data, so events carry the error and its stack trace and nothing about
 * the request that caused it: no bodies, cookies, headers or query strings, no
 * network or console breadcrumbs (they echo URLs, payloads and logged values),
 * no Replay, no tracing.
 */
export const privacyOptions = {
  sendDefaultPii: false,
  tracesSampleRate: 0,
  beforeSend: scrubEvent,
  beforeBreadcrumb: (crumb: Breadcrumb) => scrubBreadcrumb(crumb),
};

/** Breadcrumbs that record network calls or console output. */
const DROPPED_CATEGORIES = new Set(["fetch", "xhr", "http", "console"]);

/**
 * The patient page's link token is a credential — anyone holding it can read
 * and write that patient's handout log — so it never leaves the server.
 */
const TOKEN_PATH = /(\/(?:h|api\/handout)\/)[^/?#]+/g;

/** Drops the query string and fragment, and masks portal tokens. */
export function scrubUrl(url: string): string {
  return url.replace(/[?#].*$/, "").replace(TOKEN_PATH, "$1[token]");
}

export function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb | null {
  if (crumb.category && DROPPED_CATEGORIES.has(crumb.category)) return null;
  if (crumb.type === "http") return null;
  if (crumb.category === "navigation" && crumb.data) {
    const data = { ...crumb.data };
    for (const key of ["from", "to"]) {
      if (typeof data[key] === "string") data[key] = scrubUrl(data[key]);
    }
    return { ...crumb, data };
  }
  return crumb;
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    const { url, method } = event.request;
    event.request = { method, ...(url ? { url: scrubUrl(url) } : {}) };
  }
  delete event.user;
  // onRequestError records the raw request path, query string included.
  const nextjs = event.contexts?.nextjs;
  if (nextjs && typeof nextjs.request_path === "string") {
    nextjs.request_path = scrubUrl(nextjs.request_path);
  }
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((c) => scrubBreadcrumb(c) ?? []);
  }
  return event;
}
