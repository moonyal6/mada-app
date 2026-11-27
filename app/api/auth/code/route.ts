import { clientIp } from "@/lib/server/clientIp";
import { requestLoginCode } from "@/lib/server/loginCodes";

export const runtime = "nodejs";

const STATUS = { invalid_identifier: 400, sender_unavailable: 503, too_many_requests: 429, unknown_account: 404 } as const;

/**
 * Asks for a login code (#45). The same answer for every well-formed
 * identifier, whether or not an account has it. POST only: anything else is 405.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { identifier } = body as Record<string, unknown>;
  const { status } = await requestLoginCode({
    identifier: typeof identifier === "string" ? identifier : "",
    ip: clientIp(request),
  });
  if (status === "accepted") return Response.json({ ok: true });
  return Response.json({ error: status }, { status: STATUS[status] });
}
