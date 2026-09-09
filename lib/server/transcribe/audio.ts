import "server-only";
import { spawn } from "node:child_process";

/**
 * Cheap speech-presence check, run before any provider sees the audio.
 * ffmpeg decodes the segment to 16 kHz mono PCM; frames are scored in dBFS
 * and compared against the segment's own noise floor, so a quiet speaker on
 * a quiet mic still counts as speech while a room's hum does not.
 *
 * Returns null when ffmpeg is missing or the file cannot be decoded — the
 * caller then sends the audio as-is and lets the provider (and the text
 * filters) decide.
 */

export type AudioAnalysis = {
  seconds: number;
  /** Seconds of frames judged to contain speech. */
  speechSeconds: number;
  peakDb: number;
  floorDb: number;
  silent: boolean;
};

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const RATE = 16_000;
const FRAME = Math.round(RATE * 0.02); // 20 ms
/** Nothing above this anywhere → silence regardless of the floor. */
const PEAK_SILENT_DB = -48;
/** Speech must sit clearly above the floor and above an absolute minimum. */
const ABOVE_FLOOR_DB = 12;
const MIN_SPEECH_DB = -46;
/** Less voiced audio than this in a whole segment → skip it. */
const MIN_SPEECH_SECONDS = 0.5;

function decodePcm(filePath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (v: Buffer | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let proc;
    try {
      proc = spawn(
        FFMPEG,
        ["-hide_banner", "-loglevel", "error", "-i", filePath, "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      done(null);
    }, 30_000);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("error", () => {
      clearTimeout(timer);
      done(null);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      done(code === 0 ? Buffer.concat(chunks) : null);
    });
  });
}

export async function analyseAudio(filePath: string): Promise<AudioAnalysis | null> {
  const pcm = await decodePcm(filePath);
  if (!pcm || pcm.length < FRAME * 2) return null;
  const samples = Math.floor(pcm.length / 2);
  const frames: number[] = [];
  for (let start = 0; start + FRAME <= samples; start += FRAME) {
    let sum = 0;
    for (let i = start; i < start + FRAME; i += 1) {
      const s = pcm.readInt16LE(i * 2) / 32768;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / FRAME);
    frames.push(rms > 0 ? 20 * Math.log10(rms) : -100);
  }
  if (!frames.length) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  const floorDb = sorted[Math.floor(sorted.length * 0.1)];
  const peakDb = sorted[sorted.length - 1];
  const threshold = Math.max(MIN_SPEECH_DB, floorDb + ABOVE_FLOOR_DB);
  const speechFrames = frames.filter((db) => db > threshold).length;
  const speechSeconds = (speechFrames * FRAME) / RATE;
  const seconds = samples / RATE;
  return {
    seconds,
    speechSeconds,
    peakDb,
    floorDb,
    silent: peakDb < PEAK_SILENT_DB || speechSeconds < MIN_SPEECH_SECONDS,
  };
}
