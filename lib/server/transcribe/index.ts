import "server-only";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SttStatus } from "@/lib/types";

const execFileP = promisify(execFile);

/**
 * The transcription boundary. Everything above this module hands over a file
 * path and gets Arabic text back; everything below is provider plumbing.
 * Swapping providers — or extracting the whole thing into a separate service
 * later — happens here and nowhere else.
 *
 * Providers:
 *  - "openai" / "groq": OpenAI-compatible `/audio/transcriptions` (multipart).
 *  - "local": whisper.cpp CLI on the server (ffmpeg converts to 16k wav).
 *  - "auto" (default): openai key → openai; groq key → groq; local binary → local.
 */

export type TranscribeInput = {
  filePath: string;
  mime: string;
  /** Tail of the transcript so far — keeps names/terms consistent across segments. */
  prompt?: string;
};

type Provider = {
  key: "openai" | "groq" | "local";
  label: string;
  /** null when usable, otherwise a human reason. */
  unavailable(): string | null;
  transcribe(input: TranscribeInput): Promise<string>;
};

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const WHISPER_CLI =
  process.env.WHISPER_CLI || path.join(process.cwd(), "vendor/whisper-cpp/whisper-cli");
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), "vendor/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin");

function extForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

function openAiCompatible(
  key: "openai" | "groq",
  label: string,
  baseUrl: string,
  apiKeyEnv: string,
  defaultModel: string,
): Provider {
  return {
    key,
    label,
    unavailable() {
      return process.env[apiKeyEnv] ? null : `${apiKeyEnv} غير مضبوط`;
    },
    async transcribe({ filePath, mime, prompt }) {
      const model = process.env.MADA_STT_MODEL || defaultModel;
      const bytes = await fs.readFile(filePath);
      const form = new FormData();
      form.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: mime }),
        `segment.${extForMime(mime)}`,
      );
      form.append("model", model);
      form.append("language", "ar");
      form.append("response_format", "json");
      if (prompt) form.append("prompt", prompt);

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env[apiKeyEnv]}` },
        body: form,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${label} ${res.status}: ${body.slice(0, 300)}`);
      }
      const data = (await res.json()) as { text?: string };
      return (data.text ?? "").trim();
    },
  };
}

const localWhisper: Provider = {
  key: "local",
  label: "خادم العيادة (Whisper محلي)",
  unavailable() {
    if (!existsSync(WHISPER_CLI)) return "whisper-cli غير موجود";
    if (!existsSync(WHISPER_MODEL)) return "نموذج whisper غير موجود";
    return null;
  },
  async transcribe({ filePath, prompt }) {
    const wavPath = filePath + ".wav";
    try {
      await execFileP(
        FFMPEG,
        ["-y", "-hide_banner", "-loglevel", "error", "-i", filePath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
        { timeout: 60_000 },
      );
      const args = [
        "-m", WHISPER_MODEL,
        "-l", "ar",
        "-f", wavPath,
        "--no-timestamps",
        "--no-prints",
        "-t", "4",
      ];
      if (prompt) args.push("--prompt", prompt);
      const { stdout } = await execFileP(WHISPER_CLI, args, {
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout
        .replaceAll(/\[[A-Z_ ]+\]/g, "") // [BLANK_AUDIO], [MUSIC] markers
        .replaceAll(/\s+/g, " ")
        .trim();
    } finally {
      await fs.rm(wavPath, { force: true }).catch(() => {});
    }
  },
};

const PROVIDERS: Record<string, Provider> = {
  openai: openAiCompatible(
    "openai",
    "OpenAI",
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    "OPENAI_API_KEY",
    "gpt-4o-transcribe",
  ),
  groq: openAiCompatible(
    "groq",
    "Groq",
    "https://api.groq.com/openai/v1",
    "GROQ_API_KEY",
    "whisper-large-v3",
  ),
  local: localWhisper,
};

export function activeProvider(): Provider | null {
  const pick = (process.env.MADA_STT || "auto").toLowerCase();
  if (pick !== "auto") {
    const p = PROVIDERS[pick];
    return p && !p.unavailable() ? p : (p ?? null);
  }
  for (const name of ["openai", "groq", "local"] as const) {
    if (!PROVIDERS[name].unavailable()) return PROVIDERS[name];
  }
  return null;
}

export function sttStatus(): SttStatus {
  const p = activeProvider();
  if (!p) {
    return {
      ready: false,
      providerLabel: null,
      reason:
        "لا يوجد مزوّد تفريغ صوتي مهيّأ — اضبط OPENAI_API_KEY أو GROQ_API_KEY أو ثبّت whisper.cpp محلياً.",
    };
  }
  const reason = p.unavailable();
  return { ready: !reason, providerLabel: p.label, reason };
}

export async function transcribeFile(input: TranscribeInput): Promise<string> {
  const p = activeProvider();
  if (!p) throw new Error("no_stt_provider");
  const reason = p.unavailable();
  if (reason) throw new Error(`stt_unavailable: ${reason}`);
  return p.transcribe(input);
}

/** Local whisper is CPU/GPU-bound — one at a time; HTTP providers can overlap. */
export function providerConcurrency(): number {
  return activeProvider()?.key === "local" ? 1 : 3;
}
