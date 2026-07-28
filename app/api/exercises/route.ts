/**
 * Exercise suggestions.
 *
 * This handler is the seam where the KSA-hosted backend will plug in for PDPL
 * compliance. Only the therapist's free-text query leaves the browser — no
 * patient data is sent here, and nothing is persisted.
 */
import Anthropic from "@anthropic-ai/sdk";
import { EX_SEARCH_SYS } from "@/lib/prompts";
import type { Exercise } from "@/lib/types";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const MAX_QUERY_CHARS = 500;

function toExercise(value: unknown): Exercise | null {
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
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_QUERY_CHARS * 8) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

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

  let raw: string;
  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: EX_SEARCH_SYS,
      messages: [{ role: "user", content: query.trim() }],
    });
    raw = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim()
      .replace(/```json|```/g, "")
      .trim();
  } catch {
    return Response.json({ error: "upstream_failed" }, { status: 502 });
  }

  // Parsing happens server-side; a malformed answer is a 422 so the UI can
  // fall back to the manual add panel.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }

  if (!Array.isArray(parsed)) {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }

  const exercises = parsed
    .map(toExercise)
    .filter((exercise): exercise is Exercise => exercise !== null);

  if (!exercises.length) {
    return Response.json({ error: "unparseable" }, { status: 422 });
  }

  return Response.json({ exercises });
}
