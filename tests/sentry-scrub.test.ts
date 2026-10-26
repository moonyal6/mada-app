import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { privacyOptions, scrubBreadcrumb, scrubEvent, scrubUrl } from "@/lib/sentry";

function event(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    type: undefined,
    exception: { values: [{ type: "Error", value: "boom" }] },
    ...overrides,
  };
}

describe("privacyOptions", () => {
  it("sends errors only, without default PII", () => {
    expect(privacyOptions.sendDefaultPii).toBe(false);
    expect(privacyOptions.tracesSampleRate).toBe(0);
    expect(privacyOptions.beforeSend).toBe(scrubEvent);
  });
});

describe("scrubUrl", () => {
  it("drops the query string and fragment", () => {
    expect(scrubUrl("https://mada.app/patients/7?name=سارة#notes")).toBe("https://mada.app/patients/7");
  });

  it("masks the patient page token, in the page and API paths", () => {
    expect(scrubUrl("https://mada.app/h/Ab3xYz")).toBe("https://mada.app/h/[token]");
    expect(scrubUrl("/api/handout/Ab3xYz/log")).toBe("/api/handout/[token]/log");
  });

  it("leaves other paths alone", () => {
    expect(scrubUrl("/api/sessions/12")).toBe("/api/sessions/12");
    expect(scrubUrl("/hooks/x")).toBe("/hooks/x");
  });
});

describe("scrubEvent", () => {
  it("keeps only the method and a scrubbed URL of the request", () => {
    const out = scrubEvent(
      event({
        request: {
          method: "POST",
          url: "https://mada.app/api/handout/secret/log?day=3",
          data: { pain: 7, note: "ألم في الركبة" },
          query_string: "day=3",
          cookies: { mada_therapist: "د. أحمد" },
          headers: { cookie: "mada_therapist=x", "user-agent": "x" },
          env: { REMOTE_ADDR: "10.0.0.2" },
        },
      }),
    );
    expect(out.request).toEqual({ method: "POST", url: "https://mada.app/api/handout/[token]/log" });
  });

  it("scrubs the request path Next.js reports with a server error", () => {
    const out = scrubEvent(
      event({ contexts: { nextjs: { request_path: "/h/secret?ref=sms", router_path: "/h/[token]" } } }),
    );
    expect(out.contexts?.nextjs).toEqual({ request_path: "/h/[token]", router_path: "/h/[token]" });
  });

  it("removes the user and scrubs the transaction", () => {
    const out = scrubEvent(event({ user: { ip_address: "10.0.0.2" }, transaction: "/h/secret" }));
    expect(out.user).toBeUndefined();
    expect(out.transaction).toBe("/h/[token]");
  });

  it("drops network and console breadcrumbs, keeps the rest", () => {
    const out = scrubEvent(
      event({
        breadcrumbs: [
          { category: "fetch", data: { url: "/api/patients", method: "POST" } },
          { category: "xhr", data: { url: "/api/sessions" } },
          { category: "http", data: { url: "https://api.openai.com" } },
          { type: "http", category: "net", data: { url: "x" } },
          { category: "console", message: "patient سارة saved" },
          { category: "ui.click", message: "button.save" },
        ],
      }),
    );
    expect(out.breadcrumbs).toEqual([{ category: "ui.click", message: "button.save" }]);
  });

  it("keeps the exception and its stack trace", () => {
    const frames = [{ filename: "app/api/x/route.ts", lineno: 4 }];
    const out = scrubEvent(
      event({ exception: { values: [{ type: "Error", value: "boom", stacktrace: { frames } }] } }),
    );
    expect(out.exception?.values?.[0].stacktrace?.frames).toEqual(frames);
  });
});

describe("scrubBreadcrumb", () => {
  it("scrubs navigation URLs", () => {
    expect(
      scrubBreadcrumb({ category: "navigation", data: { from: "/h/secret?x=1", to: "/patients/3" } }),
    ).toEqual({ category: "navigation", data: { from: "/h/[token]", to: "/patients/3" } });
  });
});
