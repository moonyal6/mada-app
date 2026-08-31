import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * The one place server code talks to Claude. Routes hand over a system
 * prompt and a user message; nothing about the upstream (key, status codes)
 * leaks past this module.
 */

export const CLAUDE_MODEL = process.env.MADA_CLAUDE_MODEL || "claude-opus-5";

export type ClaudeResult =
  | { ok: true; text: string }
  | { ok: false; error: "not_configured" | "refusal" | "upstream_failed" | "empty_response" };

export async function claudeText(opts: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<ClaudeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "not_configured" };

  try {
    const client = new Anthropic({ apiKey });
    // Server-side refusal fallbacks: if the primary model declines (rare but
    // possible with clinical text), the API retries on a fallback model in the
    // same call instead of surfacing an error mid-demo.
    const message = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 4000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      betas: ["server-side-fallback-2026-07-01"],
      // Short structured drafting — low effort keeps live-demo latency down.
      // (Cast: this SDK version's types predate output_config/fallbacks.)
      ...({
        output_config: { effort: "low" },
        fallbacks: "default",
      } as Record<string, unknown>),
    });

    if (message.stop_reason === "refusal") return { ok: false, error: "refusal" };

    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) return { ok: false, error: "empty_response" };
    return { ok: true, text };
  } catch {
    return { ok: false, error: "upstream_failed" };
  }
}
