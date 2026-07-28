/**
 * Report writing.
 *
 * This handler is the seam where the KSA-hosted backend will plug in for PDPL
 * compliance: today it forwards the package straight to Anthropic and returns
 * the text. Nothing is persisted — no patient data is written to disk, to a
 * database, or to logs anywhere in this file.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SYS_PROMPT } from "@/lib/prompts";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1000;
const MAX_PKG_CHARS = 20_000;

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PKG_CHARS * 4) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

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

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYS_PROMPT,
      messages: [{ role: "user", content: pkg }],
    });

    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!text) {
      return Response.json({ error: "empty_response" }, { status: 502 });
    }
    return Response.json({ text });
  } catch {
    // Nothing about the upstream call (status, message, key state) reaches the
    // client; the UI only needs to know it should fall back to manual mode.
    return Response.json({ error: "upstream_failed" }, { status: 502 });
  }
}
