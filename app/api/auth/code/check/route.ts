import { clientIp } from "@/lib/server/clientIp";
import { checkLoginCode } from "@/lib/server/loginCodes";

export const runtime = "nodejs";

const STATUS = {
  invalid_identifier: 400,
  invalid_code_format: 400,
  invalid_code: 401,
  too_many_attempts: 429,
} as const;

/**
 * Checks a login code (#45). A correct code is used up. Until sign-in (#46)
 * that is all it does: the answer carries nothing about the account.
 * POST only: anything else is 405.
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
  const { identifier, code } = body as Record<string, unknown>;
  const result = await checkLoginCode({
    identifier: typeof identifier === "string" ? identifier : "",
    code: typeof code === "string" ? code : "",
    ip: clientIp(new Request("http://x")),
  });
  if (result.status === "ok") return Response.json({ ok: true });
  return Response.json({ error: result.status }, { status: STATUS[result.status] });
}
