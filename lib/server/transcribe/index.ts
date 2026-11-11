import "server-only";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { SttProviderInfo, SttStatus } from "@/lib/types";
import { STT_AUTO, normalizeSttChoice } from "@/lib/stt";
import { analyseAudio } from "./audio";
import { SttError, asSttError, combine, fromFetchFailure, fromHttp } from "./errors";
import { buildPrompt, cleanTranscript, degenerateReason } from "./quality";

const execFileP = promisify(execFile);

/**
 * The transcription boundary. Everything above this module hands over a file
 * path and gets Arabic text back; everything below is provider plumbing.
 * Swapping providers — or extracting the whole thing into a separate service
 * later — happens here and nowhere else.
 *
 * Providers:
 *  - "openai" / "groq": OpenAI-compatible `/audio/transcriptions` (multipart).
 *  - "local": whisper.cpp server on this machine (ffmpeg converts to 16k wav).
 *
 * Choice, in order of precedence: the device's cookie (a provider key or
 * "auto"), then `MADA_STT`, then "auto". A named provider is pinned — used
 * alone, so a therapist who picked the local server for privacy never has
 * audio quietly sent elsewhere. "auto" tries every configured provider in
 * order (openai → groq → local) and, when one fails for a reason another
 * might not share (quota, key, outage), moves on to the next for that segment.
 */

export type TranscribeInput = {
  filePath: string;
  mime: string;
  /** Tail of the transcript so far — keeps names/terms consistent across segments. */
  prompt?: string;
  /** The device's provider choice at upload time (cookie value); "" = server default. */
  preferred?: string;
};

export type TranscribeNote = "" | "silence" | "degenerate" | "failover";

export type TranscribeResult = {
  text: string;
  /** Label of the provider that produced the text ("" when nothing was sent). */
  provider: string;
  note: TranscribeNote;
};

type ProviderKey = "openai" | "groq" | "local";

type Provider = {
  key: ProviderKey;
  label: string;
  /** null when usable, otherwise a human reason. */
  unavailable(): string | null;
  transcribe(input: { filePath: string; mime: string; prompt: string }): Promise<string>;
};

const ORDER: ProviderKey[] = ["openai", "groq", "local"];

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const WHISPER_SERVER =
  process.env.WHISPER_SERVER ||
  path.join(process.cwd(), "vendor/whisper-cpp/whisper-server");
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), "vendor/whisper-cpp/models/ggml-large-v3-turbo-q5_0.bin");
const WHISPER_PORT = Number(process.env.WHISPER_PORT || 18317);

function extForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

function openAiCompatible(
  key: "openai" | "groq",
  label: string,
  baseUrl: () => string,
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
      // Greedy decoding: sampling is where the invented, repeated text comes from.
      form.append("temperature", "0");
      form.append("prompt", prompt);

      let res: Response;
      try {
        res = await fetch(`${baseUrl()}/audio/transcriptions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${process.env[apiKeyEnv]}` },
          body: form,
          signal: AbortSignal.timeout(90_000),
        });
      } catch (err) {
        throw fromFetchFailure(label, err);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw fromHttp(label, res.status, body);
      }
      const data = (await res.json()) as { text?: string };
      return data.text ?? "";
    },
  };
}

/**
 * whisper-server child, spawned lazily and kept warm — a cold whisper-cli run
 * pays ~15s of model load per segment; the warm server answers in 1–3s.
 */
declare global {
  var __madaWhisper: { proc: ChildProcess | null; ready: Promise<void> | null } | undefined;
}

function whisperState() {
  if (!globalThis.__madaWhisper) {
    globalThis.__madaWhisper = { proc: null, ready: null };
  }
  return globalThis.__madaWhisper;
}

async function waitForServer(deadlineMs: number): Promise<void> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${WHISPER_PORT}/`, {
        signal: AbortSignal.timeout(1500),
      });
      return;
    } catch {
      if (Date.now() > until) throw new Error("whisper-server لم يستجب");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export function ensureWhisperServer(): Promise<void> {
  const st = whisperState();
  if (st.proc && st.proc.exitCode === null && st.ready) return st.ready;
  const proc = spawn(
    WHISPER_SERVER,
    ["-m", WHISPER_MODEL, "--host", "127.0.0.1", "--port", String(WHISPER_PORT), "-t", "4"],
    { stdio: "ignore" },
  );
  proc.on("exit", () => {
    if (whisperState().proc === proc) {
      whisperState().proc = null;
      whisperState().ready = null;
    }
  });
  st.proc = proc;
  st.ready = waitForServer(45_000);
  return st.ready;
}

const LOCAL_LABEL = "خادم العيادة (Whisper محلي)";

const localWhisper: Provider = {
  key: "local",
  label: LOCAL_LABEL,
  unavailable() {
    if (!existsSync(WHISPER_SERVER)) return "whisper-server غير موجود";
    if (!existsSync(WHISPER_MODEL)) return "نموذج whisper غير موجود";
    return null;
  },
  async transcribe({ filePath, prompt }) {
    try {
      await ensureWhisperServer();
    } catch (err) {
      throw new SttError("unreachable", LOCAL_LABEL, err instanceof Error ? err.message : "");
    }
    const wavPath = filePath + ".wav";
    try {
      try {
        await execFileP(
          FFMPEG,
          ["-y", "-hide_banner", "-loglevel", "error", "-i", filePath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
          { timeout: 60_000 },
        );
      } catch (err) {
        throw new SttError("bad_audio", LOCAL_LABEL, `ffmpeg: ${err instanceof Error ? err.message : ""}`);
      }
      const wav = await fs.readFile(wavPath);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "segment.wav");
      form.append("language", "ar");
      form.append("response_format", "json");
      form.append("temperature", "0");
      form.append("temperature_inc", "0"); // no fallback sampling passes either
      form.append("suppress_non_speech", "true");
      form.append("prompt", prompt);
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw fromFetchFailure(LOCAL_LABEL, err);
      }
      if (!res.ok) {
        throw fromHttp(LOCAL_LABEL, res.status, await res.text().catch(() => ""));
      }
      const data = (await res.json()) as { text?: string };
      return data.text ?? "";
    } finally {
      await fs.rm(wavPath, { force: true }).catch(() => {});
    }
  },
};

const PROVIDERS: Record<ProviderKey, Provider> = {
  openai: openAiCompatible(
    "openai",
    "OpenAI",
    () => process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    "OPENAI_API_KEY",
    "gpt-4o-transcribe",
  ),
  groq: openAiCompatible(
    "groq",
    "Groq",
    () => "https://api.groq.com/openai/v1",
    "GROQ_API_KEY",
    "whisper-large-v3",
  ),
  local: localWhisper,
};

function isKey(v: string): v is ProviderKey {
  return (ORDER as string[]).includes(v);
}

/** What the server uses when the device has chosen nothing: MADA_STT or "auto". */
function defaultChoice(): string {
  const env = normalizeSttChoice(process.env.MADA_STT);
  return isKey(env) ? env : STT_AUTO;
}

/** Resolve a raw cookie value to "auto" or a known provider key. */
function resolveChoice(preferred: string | undefined): string {
  const v = normalizeSttChoice(preferred);
  if (v === STT_AUTO || isKey(v)) return v;
  return defaultChoice();
}

/**
 * The providers a segment may be sent to, in order. A pinned provider comes
 * back alone even when unavailable (so the caller can say *why*); "auto"
 * yields only the configured ones.
 */
function chainFor(choice: string): Provider[] {
  if (isKey(choice)) return [PROVIDERS[choice]];
  return ORDER.map((k) => PROVIDERS[k]).filter((p) => !p.unavailable());
}

export function sttStatus(preferred?: string): SttStatus {
  const selected = resolveChoice(preferred);
  const providers: SttProviderInfo[] = ORDER.map((k) => {
    const reason = PROVIDERS[k].unavailable();
    return { key: k, label: PROVIDERS[k].label, available: !reason, reason };
  });
  const chain = chainFor(selected);
  const base = {
    providers,
    selected,
    defaultChoice: defaultChoice(),
    chain: chain.map((p) => p.label),
    keepsAudioLocal: chain.length > 0 && chain.every((p) => p.key === "local"),
  };
  if (!chain.length) {
    return {
      ...base,
      ready: false,
      providerLabel: null,
      reason:
        "لا يوجد مزوّد تفريغ صوتي مهيّأ على الخادم (OPENAI_API_KEY أو GROQ_API_KEY أو whisper.cpp محلياً). تواصل مع المطوّر.",
    };
  }
  const first = chain[0];
  const reason = first.unavailable();
  if (chain.some((p) => p.key === "local" && !p.unavailable())) {
    // Pre-warm: the consent dialog fetches this before the first recording,
    // which gives the model its ~10s load head start.
    void ensureWhisperServer().catch(() => {});
  }
  return {
    ...base,
    ready: !reason,
    providerLabel: first.label,
    reason: reason
      ? `${first.label} غير متاح: ${reason}. اختر مزوّداً آخر أو تواصل مع المطوّر.`
      : null,
  };
}

/** `<rid>/<seq>` from `…/recordings/<rid>/<seq>.<ext>`, for log lines. */
function segmentId(filePath: string): string {
  return `${path.basename(path.dirname(filePath))}/${path.basename(filePath, path.extname(filePath))}`;
}

export async function transcribeFile(input: TranscribeInput): Promise<TranscribeResult> {
  const choice = resolveChoice(input.preferred);
  const chain = chainFor(choice);
  if (!chain.length) throw new SttError("no_provider", "");
  if (chain.length === 1) {
    const reason = chain[0].unavailable();
    if (reason) throw new SttError("unavailable", chain[0].label, reason);
  }

  // Nothing said → nothing to transcribe. Sending silence is how the model
  // ends up inventing text.
  const audio = await analyseAudio(input.filePath);
  if (audio?.silent) {
    console.log(
      `[stt] skipped silent segment (${audio.seconds.toFixed(1)}s, speech ${audio.speechSeconds.toFixed(2)}s, peak ${audio.peakDb.toFixed(0)} dB)`,
    );
    return { text: "", provider: "", note: "silence" };
  }

  const prompt = buildPrompt(input.prompt);
  const failures: SttError[] = [];
  for (const p of chain) {
    let raw: string;
    try {
      raw = await p.transcribe({ filePath: input.filePath, mime: input.mime, prompt });
    } catch (err) {
      // Codes, statuses and class names only. detail and message can quote a
      // provider's response, which can quote the prompt (the transcript tail).
      const errName = err instanceof Error ? err.name : typeof err;
      const e = asSttError(err, p.label);
      console.error(`[stt] ${p.key} ${e.code} ${e.status ?? errName}`);
      failures.push(e);
      if (!e.failover) break;
      continue;
    }
    const text = cleanTranscript(raw);
    const bad = degenerateReason(text);
    if (bad) {
      // Never the text: it is patient speech, and the log is kept by the host.
      console.log(
        `[stt] ${p.key} dropped ${bad} output (${text.length} chars) ${segmentId(input.filePath)}`,
      );
      return { text: "", provider: p.label, note: "degenerate" };
    }
    return { text, provider: p.label, note: failures.length ? "failover" : "" };
  }
  throw combine(failures);
}

/** Local whisper is CPU/GPU-bound — one at a time; HTTP providers can overlap. */
export function providerConcurrency(): number {
  return chainFor(defaultChoice())[0]?.key === "local" ? 1 : 3;
}
