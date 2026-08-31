import "server-only";
import {
  getDb,
  getRecording,
  segmentPath,
  setSegmentStatus,
  transcriptTailBefore,
} from "../db";
import { providerConcurrency, transcribeFile } from "./index";

/**
 * In-process transcription queue. Segments arrive faster than a local model
 * can chew through them; this serialises the work, retries once on failure,
 * and leaves anything still broken in `failed` for the visible retry button.
 *
 * Survives dev HMR via globalThis; survives a server restart by re-enqueuing
 * every `uploaded`/`transcribing` row on first load.
 */

type Job = { recordingId: string; seq: number; attempt: number };

type QueueState = {
  jobs: Job[];
  running: number;
  recovered: boolean;
};

declare global {
  var __madaSttQueue: QueueState | undefined;
}

function state(): QueueState {
  if (!globalThis.__madaSttQueue) {
    globalThis.__madaSttQueue = { jobs: [], running: 0, recovered: false };
  }
  return globalThis.__madaSttQueue;
}

function extFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/** Re-enqueue segments that were pending when the server last stopped. */
export function recoverPending(): void {
  const s = state();
  if (s.recovered) return;
  s.recovered = true;
  const rows = getDb()
    .prepare(
      "SELECT recordingId, seq FROM segments WHERE status IN ('uploaded','transcribing') ORDER BY recordingId, seq",
    )
    .all() as { recordingId: string; seq: number }[];
  for (const r of rows) {
    s.jobs.push({ recordingId: r.recordingId, seq: r.seq, attempt: 0 });
  }
  if (rows.length) pump();
}

export function enqueueSegment(recordingId: string, seq: number): void {
  const s = state();
  recoverPending();
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
  const rec = getRecording(job.recordingId);
  if (!rec) return;
  setSegmentStatus(job.recordingId, job.seq, "transcribing");
  try {
    const text = await transcribeFile({
      filePath: segmentPath(job.recordingId, job.seq, extFor(rec.mime)),
      mime: rec.mime,
      prompt: transcriptTailBefore(job.recordingId, job.seq) || undefined,
    });
    setSegmentStatus(job.recordingId, job.seq, "done", { text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempt < 1) {
      // One automatic retry after a short pause — transient network blips.
      setSegmentStatus(job.recordingId, job.seq, "uploaded", { error: message });
      setTimeout(() => {
        state().jobs.push({ ...job, attempt: job.attempt + 1 });
        pump();
      }, 4000);
    } else {
      setSegmentStatus(job.recordingId, job.seq, "failed", { error: message });
    }
  }
}
