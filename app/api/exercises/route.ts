/**
 * Exercise suggestions. Only the therapist's free-text query leaves the
 * browser — no patient data is sent here, and nothing is persisted.
 */
import { claudeText } from "@/lib/server/claude";
import { EX_SEARCH_SYS } from "@/lib/prompts";

export const runtime = "nodejs";

const MAX_QUERY_CHARS = 500;

type Suggestion = { ar: string; en: string; desc: string };

function toSuggestion(value: unknown): Suggestion | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const ar = typeof record.ar === "string" ? record.ar.trim() : "";
  if (!ar) return null;
  return {
    ar,
    en: typeof record.en === "string" ? record.en : "",
    desc: typeof record.desc === "string" ? record.desc : "",
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const query = (body as { query?: unknown } | null)?.query;
  if (typeof query !== "string" || !query.trim()) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (query.length > MAX_QUERY_CHARS) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  const result = await claudeText({
    system: EX_SEARCH_SYS,
    user: query.trim(),
    maxTokens: 2000,
  });
  if (!result.ok) {
    const status = result.error === "not_configured" ? 503 : 502;
    return Response.json({ error: result.error }, { status });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text.replace(/```json|```/g, "").trim());
  } catch {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }
  if (!Array.isArray(parsed)) {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }
  const exercises = parsed
    .map(toSuggestion)
    .filter((s): s is Suggestion => s !== null);
  if (!exercises.length) {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }
  return Response.json({ exercises });
}
