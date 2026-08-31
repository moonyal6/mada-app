/**
 * Report writing. The package is built client-side (the therapist sees the
 * exact text) and drafted server-side behind the API key. Nothing here is
 * persisted — the draft goes back to the wizard, which autosaves it as part
 * of the session row only after the therapist has it on screen.
 */
import { claudeText } from "@/lib/server/claude";
import { REPORT_SYS } from "@/lib/prompts";

export const runtime = "nodejs";

const MAX_PKG_CHARS = 60_000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const pkg = (body as { pkg?: unknown } | null)?.pkg;
  if (typeof pkg !== "string" || !pkg.trim()) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (pkg.length > MAX_PKG_CHARS) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  const result = await claudeText({ system: REPORT_SYS, user: pkg });
  if (!result.ok) {
    const status = result.error === "not_configured" ? 503 : 502;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json({ text: result.text });
}
