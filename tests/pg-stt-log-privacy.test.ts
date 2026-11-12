import { rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SERVER_START_MS,
  createTestDb,
  makeDataDir,
  request,
  startServer,
  type Server,
  type TestDb,
} from "./pg/harness.mjs";

// #18: transcript text must not reach the server log (Railway keeps it).
//
// The server is pinned to the OpenAI provider, pointed at a stub on this
// machine, and given an ffmpeg path that doesn't exist, so the silence check
// returns null and every segment reaches the stub. Each case makes the stub
// answer with its own marker (10 characters or fewer, at the very start of
// the response, so a SyntaxError's ~10-character quote of a bad body would
// include it), then searches the whole server log for that marker.

type StubReply = { status: number; contentType: string; body: string };

/** OpenAI-compatible stand-in: answers every request with the current reply. */
function startStub() {
  let reply: StubReply = { status: 500, contentType: "text/plain", body: "no reply set" };
  let hits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits += 1;
      res.writeHead(reply.status, { "content-type": reply.contentType });
      res.end(reply.body);
    });
  });
  return new Promise<{
    url: string;
    set: (r: StubReply) => void;
    hits: () => number;
    close: () => Promise<void>;
  }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        set: (r) => {
          reply = r;
          hits = 0;
        },
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

const json = (status: number, body: unknown): StubReply => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

let db: TestDb;
let server: Server;
let stub: Awaited<ReturnType<typeof startStub>>;
const cleanups: (() => unknown)[] = [];

beforeAll(async () => {
  stub = await startStub();
  cleanups.push(stub.close);
  db = await createTestDb();
  cleanups.push(db.drop);
  const dataDir = makeDataDir();
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  server = await startServer({
    dataDir,
    env: {
      DATABASE_URL: db.url,
      MADA_STT: "openai",
      OPENAI_API_KEY: "test-key-not-real",
      OPENAI_BASE_URL: stub.url,
      FFMPEG_PATH: "/nonexistent/mada-test/ffmpeg",
    },
  });
  cleanups.push(server.stop);

  // Run the queue's once-per-process recovery now, with nothing pending. If
  // the first upload triggers it instead, recovery picks up that segment and
  // the upload enqueues it again, so the stub is called twice for one segment
  // (a queue.ts issue outside #18's scope).
  const rid = await newRecording();
  const warm = await request(server.base, "GET", `/api/recordings/${rid}`);
  expect(warm.status, JSON.stringify(warm.body)).toBe(200);
}, SERVER_START_MS + 30_000);

afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
}, 30_000);

/** Patient, session, consent, recording. Returns the recording id. */
async function newRecording(): Promise<string> {
  const created = await request(server.base, "POST", "/api/patients", {
    body: { name: "مريض اختبار", caseKey: "back" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const patientId: string = created.body.patient.id;

  const session = await request(server.base, "POST", "/api/sessions", { body: { patientId } });
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

/** A new recording with segment 1 uploaded. Returns the recording id. */
async function uploadOneSegment(): Promise<string> {
  const rid = await newRecording();
  const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
  const upload = await request(server.base, "PUT", `/api/recordings/${rid}/segments/1`, { raw: audio });
  expect(upload.status, JSON.stringify(upload.body)).toBe(200);
  return rid;
}

type Segment = { seq: number; status: string; text: string; error: string; provider: string; note: string };

/** Polls until segment 1 is done or failed. */
async function settle(rid: string, timeoutMs = 30_000): Promise<Segment> {
  const deadline = Date.now() + timeoutMs;
  let last: Segment | undefined;
  for (;;) {
    const res = await request(server.base, "GET", `/api/recordings/${rid}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    last = (res.body.segments as Segment[]).find((s) => s.seq === 1);
    if (last && (last.status === "done" || last.status === "failed")) return last;
    if (Date.now() > deadline) {
      throw new Error(`segment 1 of ${rid} did not settle in ${timeoutMs} ms: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The log reaches the test through a pipe, a moment after the HTTP response
 * that reported the segment settled. Waits for `expected` (up to `ms`), so a
 * leak printed just before it isn't missed by the marker check.
 */
async function logAfter(expected: RegExp | null, ms = 3000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (expected && expected.test(server.log())) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return server.log();
}

function expectNoMarker(log: string, marker: string) {
  const leaked = log.split("\n").filter((l) => l.includes(marker));
  expect(leaked, `transcript marker "${marker}" found in the server log`).toEqual([]);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

describe("[stt] log lines carry no transcript text (#18)", () => {
  it(
    "control: a normal Arabic transcript is stored and not logged",
    async () => {
      const marker = "زعفران";
      const text = `${marker} المريض يشكو من ألم في أسفل الظهر منذ أسبوعين ويزداد عند الجلوس الطويل`;
      stub.set(json(200, { text }));
      const rid = await uploadOneSegment();
      const seg = await settle(rid);
      expect(seg.status, JSON.stringify(seg)).toBe("done");
      expect(stub.hits()).toBe(1);

      const rows = await db.query(`SELECT text FROM segments WHERE "recordingId" = $1 AND seq = 1`, [rid]);
      expect(rows).toEqual([{ text }]);

      expectNoMarker(await logAfter(null, 1000), marker);
    },
    60_000,
  );

  it(
    "repetition: dropped with its length and <rid>/<seq>, not its text",
    async () => {
      const marker = "قرنفل";
      const text = Array(30).fill(marker).join(" ");
      stub.set(json(200, { text }));
      const rid = await uploadOneSegment();
      const seg = await settle(rid);
      expect(seg.status, JSON.stringify(seg)).toBe("done");
      expect(seg.note).toBe("degenerate");

      const line = new RegExp(
        `\\[stt\\] openai dropped repetition output \\(${text.length} chars\\) ${escape(rid)}/1(?:\\n|$)`,
      );
      const log = await logAfter(line);
      expectNoMarker(log, marker);
      expect(log).toMatch(line);
    },
    60_000,
  );

  it(
    "non-Arabic: dropped with its length and <rid>/<seq>, not its text",
    async () => {
      const marker = "Жмурки";
      const text = `${marker} сегодня пациент жалуется на сильную боль в спине`;
      stub.set(json(200, { text }));
      const rid = await uploadOneSegment();
      const seg = await settle(rid);
      expect(seg.status, JSON.stringify(seg)).toBe("done");
      expect(seg.note).toBe("degenerate");

      const line = new RegExp(
        `\\[stt\\] openai dropped non_arabic output \\(${text.length} chars\\) ${escape(rid)}/1(?:\\n|$)`,
      );
      const log = await logAfter(line);
      expectNoMarker(log, marker);
      expect(log).toMatch(line);
    },
    60_000,
  );

  it(
    "bad JSON with status 200: logs the error class, not the body Node quotes",
    async () => {
      const marker = "ثعلبيات";
      stub.set({ status: 200, contentType: "application/json", body: `${marker} {not json` });
      const rid = await uploadOneSegment();
      // Transient: one automatic retry after ~4s, so the stub answers twice.
      const seg = await settle(rid);
      expect(seg.status, JSON.stringify(seg)).toBe("failed");
      expect(stub.hits()).toBe(2);

      const line = /\[stt\] openai server SyntaxError(?:\n|$)/;
      const log = await logAfter(line);
      expectNoMarker(log, marker);
      expect(log).toMatch(line);
    },
    60_000,
  );

  it(
    "HTTP 400: logs the status, not the provider's error body",
    async () => {
      const marker = "سنونوات";
      // "invalid prompt" must not match fromHttp's bad-audio pattern, so this
      // maps to `rejected`, not `bad_audio`.
      stub.set(json(400, { error: { message: `${marker} invalid prompt` } }));
      const rid = await uploadOneSegment();
      const seg = await settle(rid);
      expect(seg.status, JSON.stringify(seg)).toBe("failed");
      expect(stub.hits()).toBe(1);

      const line = /\[stt\] openai rejected 400(?:\n|$)/;
      const log = await logAfter(line);
      expectNoMarker(log, marker);
      expect(log).toMatch(line);
    },
    60_000,
  );
});
