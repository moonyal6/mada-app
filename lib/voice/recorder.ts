"use client";

/**
 * Segmented voice capture. Instead of one long MediaRecorder stream (whose
 * later chunks aren't independently decodable), the recorder is rotated every
 * SEGMENT_MS so each blob is a standalone playable file. Segments upload as
 * they're produced; a network drop just queues them locally and retries with
 * backoff, so everything captured before (and during) the drop survives.
 * Nothing in a 40-minute session depends on the connection staying up.
 */

export type RecorderSnapshot = {
  phase: "idle" | "starting" | "recording" | "draining" | "stopped" | "error";
  /** Human-readable Arabic error, when phase === "error". */
  error: string | null;
  recordingId: string | null;
  /** Segments captured locally so far. */
  captured: number;
  /** Segments waiting to reach the server (in-flight + queued). */
  pendingUpload: number;
  /** True while uploads are failing and being retried. */
  offline: boolean;
};

type QueueItem = { seq: number; blob: Blob; attempts: number };

const SEGMENT_MS = 15_000;

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "الوصول للميكروفون مرفوض — فعّله من إعدادات المتصفح ثم أعد المحاولة.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "لا يوجد ميكروفون متاح على هذا الجهاز.";
  }
  return "تعذّر تشغيل الميكروفون.";
}

export class SegmentedRecorder {
  private sessionId: string;
  private segmentMs: number;
  private onChange: (s: RecorderSnapshot) => void;

  private snapshot: RecorderSnapshot = {
    phase: "idle",
    error: null,
    recordingId: null,
    captured: 0,
    pendingUpload: 0,
    offline: false,
  };

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private mime = "";
  private nextSeq = 0;
  private queue: QueueItem[] = [];
  private uploading = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    sessionId: string;
    segmentMs?: number;
    onChange: (s: RecorderSnapshot) => void;
  }) {
    this.sessionId = opts.sessionId;
    this.segmentMs = opts.segmentMs ?? SEGMENT_MS;
    this.onChange = opts.onChange;
  }

  private set(patch: Partial<RecorderSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.onChange(this.snapshot);
  }

  get recordingId(): string | null {
    return this.snapshot.recordingId;
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.mime = pickMime();
    if (!this.mime) {
      this.set({ phase: "error", error: "هذا المتصفح لا يدعم تسجيل الصوت." });
      return;
    }
    this.set({ phase: "starting", error: null });

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.set({ phase: "error", error: micError(err) });
      return;
    }

    let recordingId: string;
    try {
      const res = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: this.sessionId, mime: this.mime }),
      });
      if (!res.ok) throw new Error(String(res.status));
      recordingId = ((await res.json()) as { id: string }).id;
    } catch {
      this.stopTracks();
      this.set({
        phase: "error",
        error: "تعذّر فتح التسجيل على الخادم — تحقّق من الاتصال ثم أعد المحاولة.",
      });
      return;
    }

    this.active = true;
    this.nextSeq = 0;
    this.set({ phase: "recording", recordingId, captured: 0, pendingUpload: 0 });
    this.beginSegment();
  }

  /** Stops capture; resolves after the upload queue drains (or keeps retrying). */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.recorder && this.recorder.state !== "inactive") {
      this.recorder.stop(); // flushes the final segment via onstop
    } else {
      this.finishIfDrained();
    }
    this.stopTracks();
    this.set({ phase: this.queue.length ? "draining" : "stopped" });
  }

  /** Hard teardown (unmount). Abandons queued uploads. */
  destroy(): void {
    this.active = false;
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      /* already gone */
    }
    this.stopTracks();
  }

  private stopTracks() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private beginSegment() {
    if (!this.active || !this.stream) return;
    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder;
    try {
      // 32 kbps Opus is plenty for dictation and keeps each 15s segment ~60KB —
      // four times less to retry over flaky clinic wifi than Chrome's default.
      recorder = new MediaRecorder(this.stream, {
        mimeType: this.mime,
        audioBitsPerSecond: 32_000,
      });
    } catch {
      this.active = false;
      this.stopTracks();
      this.set({ phase: "error", error: "تعذّر تشغيل مسجّل الصوت." });
      return;
    }
    this.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: this.mime });
      if (blob.size > 0) {
        const seq = this.nextSeq++;
        this.queue.push({ seq, blob, attempts: 0 });
        this.set({
          captured: this.nextSeq,
          pendingUpload: this.queue.length,
        });
        void this.pumpUploads();
      }
      if (this.active) {
        this.beginSegment();
      } else {
        this.finishIfDrained();
      }
    };
    recorder.onerror = () => {
      // Recorder died mid-segment; salvage what we have and restart.
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* ignored */
        }
      }
    };
    recorder.start();
    this.rotateTimer = setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, this.segmentMs);
  }

  private async pumpUploads(): Promise<void> {
    if (this.uploading) return;
    this.uploading = true;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      try {
        const res = await fetch(
          `/api/recordings/${this.snapshot.recordingId}/segments/${item.seq}`,
          { method: "PUT", body: item.blob },
        );
        if (!res.ok && res.status !== 413) throw new Error(String(res.status));
        // 413 = oversized segment; dropping it is better than blocking forever.
        this.queue.shift();
        this.set({ pendingUpload: this.queue.length, offline: false });
      } catch {
        item.attempts += 1;
        const backoff = Math.min(15_000, 1000 * 2 ** Math.min(item.attempts, 4));
        this.set({ offline: true, pendingUpload: this.queue.length });
        this.uploading = false;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.pumpUploads(), backoff);
        return;
      }
    }
    this.uploading = false;
    this.finishIfDrained();
  }

  private finishIfDrained() {
    if (!this.active && this.queue.length === 0 && this.snapshot.phase !== "error") {
      this.set({ phase: "stopped", pendingUpload: 0, offline: false });
    }
  }
}
