import { rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  SERVER_START_MS,
  createTestDb,
  makeDataDir,
  request,
  startServer,
  withCleanup,
  type Server,
} from "./pg/harness.mjs";

// One uploaded segment, one provider call. Provider calls are billed, and the
// queue used to send a segment twice when it was already running as it was
// enqueued again:
//  - the first upload after a server start, where the queue's once-per-process
//    recovery finds the row just saved and starts it before the upload's own
//    enqueue runs;
//  - the same segment uploaded again while it is being transcribed (the
//    recorder re-sends a segment after a network drop).
//
// The server is pinned to the OpenAI provider, pointed at a stub on this
// machine that counts requests, with an ffmpeg path that doesn't exist so the
// silence check is skipped and every segment reaches the stub.

const TEXT = "المريض يشكو من ألم في أسفل الظهر منذ أسبوعين ويزداد عند الجلوس الطويل";

/** OpenAI-compatible stand-in. Counts requests as they arrive; answers after `delayMs`. */
function startStub(delayMs: number) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: TEXT }));
      }, delayMs);
    });
  });
  return new Promise<{ url: string; hits: () => number; close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        hits: () => hits,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A fresh database, data directory, stub and server; all removed when `fn` settles. */
function withStubbedServer<T>(
  delayMs: number,
  fn: (ctx: { server: Server; hits: () => number }) => Promise<T>,
): Promise<T> {
  return withCleanup(async (defer) => {
    const stub = await startStub(delayMs);
    defer(stub.close);
    const db = await createTestDb();
    defer(db.drop);
    const dataDir = makeDataDir();
    defer(() => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startServer({
      dataDir,
      env: {
        DATABASE_URL: db.url,
        MADA_STT: "openai",
        OPENAI_API_KEY: "test-key-not-real",
        OPENAI_BASE_URL: stub.url,
        FFMPEG_PATH: "/nonexistent/mada-test/ffmpeg",
      },
    });
    defer(server.stop);
    return fn({ server, hits: stub.hits });
  });
}

/** Patient, session, consent, recording. Returns the recording id. */
async function newRecording(server: Server): Promise<string> {
  const created = await request(server.base, "POST", "/api/patients", {
    body: { name: "مريض اختبار", caseKey: "back" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);

  const session = await request(server.base, "POST", "/api/sessions", {
    body: { patientId: created.body.patient.id },
  });
  expect(session.status, JSON.stringify(session.body)).toBe(201);
  const sessionId: string = session.body.session.id;

  const consent = await request(server.base, "POST", `/api/sessions/${sessionId}/consent`);
  expect(consent.status, JSON.stringify(consent.body)).toBe(200);

  const recording = await request(server.base, "POST", "/api/recordings", {
    body: { sessionId, mime: "audio/webm;codecs=opus" },
  });
  expect(recording.status, JSON.stringify(recording.body)).toBe(201);
  return recording.body.id;
}

const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);

async function upload(server: Server, rid: string, seq: number) {
  const res = await request(server.base, "PUT", `/api/recordings/${rid}/segments/${seq}`, { raw: AUDIO });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

type Segment = { seq: number; status: string; text: string };

async function segment(server: Server, rid: string, seq: number): Promise<Segment | undefined> {
  const res = await request(server.base, "GET", `/api/recordings/${rid}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.segments as Segment[]).find((s) => s.seq === seq);
}

/** Polls until the segment reaches one of `statuses`. */
async function waitFor(server: Server, rid: string, seq: number, statuses: string[], timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await segment(server, rid, seq);
    if (s && statuses.includes(s.status)) return s;
    if (Date.now() > deadline) {
      throw new Error(`segment ${seq} of ${rid} never reached ${statuses.join("/")}: ${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Long enough for a duplicate job, started alongside the first, to reach the stub. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the transcription queue sends each segment once", () => {
  it(
    "the first upload after a server start reaches the provider once",
    () =>
      withStubbedServer(0, async ({ server, hits }) => {
        const rid = await newRecording(server);
        await upload(server, rid, 1);
        const seg = await waitFor(server, rid, 1, ["done", "failed"]);
        expect(seg.status, JSON.stringify(seg)).toBe("done");
        expect(seg.text).toBe(TEXT);
        await sleep(1000);
        expect(hits(), "provider calls for one segment").toBe(1);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "a segment uploaded again while it is being transcribed reaches the provider once",
    () =>
      // The stub holds each answer for 2s, so the second upload lands mid-call.
      withStubbedServer(2000, async ({ server, hits }) => {
        const rid = await newRecording(server);
        // Run the queue's start-up recovery now, with nothing pending, so the
        // first-upload case above isn't what this one measures.
        await segment(server, rid, 1);

        await upload(server, rid, 1);
        // The first call is in flight: the stub has it and hasn't answered.
        const deadline = Date.now() + 10_000;
        while (hits() < 1 && Date.now() < deadline) await sleep(50);
        expect(hits(), "the first call reached the stub before the re-upload").toBe(1);
        expect((await segment(server, rid, 1))?.status).toBe("transcribing");
        await upload(server, rid, 1);

        const seg = await waitFor(server, rid, 1, ["done", "failed"]);
        expect(seg.status, JSON.stringify(seg)).toBe("done");
        expect(seg.text).toBe(TEXT);
        await sleep(1000);
        expect(hits(), "provider calls for one segment").toBe(1);
      }),
    SERVER_START_MS + 60_000,
  );
});
