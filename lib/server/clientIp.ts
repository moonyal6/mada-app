import "server-only";
import { isIP } from "node:net";

/**
 * The caller's address, for the login caps (#45, D10): the `X-Real-IP`
 * header, which Railway's edge sets, trimmed and lower-cased, when it is one
 * address. Anything else (absent, empty, a list, not an address) is
 * `unknown`, and every such request shares one bucket. No other header is
 * read: Next fills `X-Forwarded-For` with the proxy's address when it is
 * absent, and a client can send its own.
 */
export function clientIp(request: Request): string {
  const value = (request.headers.get("x-forwarded-for")?.split(",").pop() ?? "").trim().toLowerCase();
  return isIP(value) ? value : "unknown";
}
