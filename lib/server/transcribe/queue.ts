import "server-only";
import {
  getRecording,
  listPendingSegments,
  segmentPath,
  segmentPreference,
  setSegmentStatus,
  transcriptTailBefore,
} from "../db";
import { SttError } from "./errors";
import { providerConcurrency, transcribeFile } from "./index";

/**
 * In-process transcription queue. Segments arrive faster than a local model
 * can chew through them; this serialises the work, retries once when the
 * failure was transient, and leaves anything still broken in `failed` (with
 * an Arabic explanation) for the visible retry button.
 *
 * Survives dev HMR via globalThis; survives a server restart by re-enqueuing
 * every `uploaded`/`transcribing` row on first load.
 */

type Job = { recordingId: string; seq: number; attempt: number };

type QueueState = {
  jobs: Job[];
  running: number;
  /** Set on the first call, so concurrent callers wait for one recovery. */
  recovery: Promise<void> | null;
};

declare global {
  var __madaSttQueue: QueueState | undefined;
}

function state(): QueueState {
  if (!globalThis.__madaSttQueue) {
    globalThis.__madaSttQueue = { jobs: [], running: 0, recovery: null };
  }
  return globalThis.__madaSttQueue;
}

function extFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/**
 * Re-enqueue segments that were pending when the server last stopped. Runs
 * once per process. Every caller waits for that one run, so a segment
 * enqueued meanwhile can't be pushed twice. A failed run isn't retried, and
 * only the caller that started it sees the error.
 */
export function recoverPending(): Promise<void> {
  const s = state();
  if (s.recovery) return s.recovery;
  const recovery = (async () => {
    const rows = await listPendingSegments();
    for (const r of rows) {
      s.jobs.push({ recordingId: r.recordingId, seq: r.seq, attempt: 0 });
    }
    if (rows.length) pump();
  })();
  s.recovery = recovery.catch(() => {});
  return recovery;
}

export async function enqueueSegment(recordingId: string, seq: number): Promise<void> {
  const s = state();
  await recoverPending();
  if (!s.jobs.some((j) => j.recordingId === recordingId && j.seq === seq)) {
    s.jobs.push({ recordingId, seq, attempt: 0 });
  }
  pump();
}

function pump(): void {
  const s = state();
  while (s.running < providerConcurrency() && s.jobs.length > 0) {
    const job = s.jobs.shift()!;
    s.running += 1;
    void run(job).finally(() => {
      s.running -= 1;
      pump();
    });
  }
}

async function run(job: Job): Promise<void> {
  const rec = await getRecording(job.recordingId);
  if (!rec) return;
  await setSegmentStatus(job.recordingId, job.seq, "transcribing");
  try {
    const result = await transcribeFile({
      filePath: segmentPath(job.recordingId, job.seq, extFor(rec.mime)),
      mime: rec.mime,
      prompt: (await transcriptTailBefore(job.recordingId, job.seq)) || undefined,
      preferred: await segmentPreference(job.recordingId, job.seq),
    });
    await setSegmentStatus(job.recordingId, job.seq, "done", {
      text: result.text,
      provider: result.provider,
      note: result.note,
      error: "",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transient = err instanceof SttError ? err.transient : true;
    if (job.attempt < 1 && transient) {
      // One automatic retry after a short pause — transient network blips.
      // Quota, key and unreadable-audio failures won't change in 4s: fail now
      // so the therapist sees why instead of waiting.
      await setSegmentStatus(job.recordingId, job.seq, "uploaded", { error: message });
      setTimeout(() => {
        state().jobs.push({ ...job, attempt: job.attempt + 1 });
        pump();
      }, 4000);
    } else {
      await setSegmentStatus(job.recordingId, job.seq, "failed", { error: message });
    }
  }
}
