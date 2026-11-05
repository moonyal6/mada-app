import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SERVER_START_MS, listDataDir, request, withServerOnFreshDb } from "./pg/harness.mjs";

// T4 of #30 (8b-2), written before the implementation. On Postgres,
// MADA_DATA_DIR keeps recordings and nothing else: no mada.db* file, and a
// segment upload lands at recordings/<rid>/<seq>.<ext> as it does today.

describe("MADA_DATA_DIR on Postgres (#30, 8b-2)", () => {
  it(
    "T4: after a run it holds no mada.db*, and a segment lands at recordings/<rid>/<seq>.<ext>",
    () =>
      withServerOnFreshDb(async ({ db, server }) => {
        const patients = await request(server.base, "GET", "/api/patients");
        expect(patients.status, JSON.stringify(patients.body)).toBe(200);

        const created = await request(server.base, "POST", "/api/patients", {
          body: { name: "مريض اختبار", caseKey: "back" },
        });
        expect(created.status, JSON.stringify(created.body)).toBe(201);

        const session = await request(server.base, "POST", "/api/sessions", { body: { patientId: "p1" } });
        expect(session.status, JSON.stringify(session.body)).toBe(201);
        const sessionId: string = session.body.session.id;

        const consent = await request(server.base, "POST", `/api/sessions/${sessionId}/consent`);
        expect(consent.status, JSON.stringify(consent.body)).toBe(200);

        const recording = await request(server.base, "POST", "/api/recordings", {
          body: { sessionId, mime: "audio/webm;codecs=opus" },
        });
        expect(recording.status, JSON.stringify(recording.body)).toBe(201);
        const rid: string = recording.body.id;

        const audio = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8]);
        const upload = await request(server.base, "PUT", `/api/recordings/${rid}/segments/3`, { raw: audio });
        expect(upload.status, JSON.stringify(upload.body)).toBe(200);
        expect(upload.body).toEqual({ ok: true, seq: 3 });

        const segmentFile = path.join(server.dataDir, "recordings", rid, "3.webm");
        expect(existsSync(segmentFile), `${segmentFile} exists`).toBe(true);
        expect(new Uint8Array(readFileSync(segmentFile))).toEqual(audio);

        const finish = await request(server.base, "POST", `/api/sessions/${sessionId}/finish`);
        expect(finish.status, JSON.stringify(finish.body)).toBe(200);

        const entries = listDataDir(server.dataDir);
        expect(
          entries.filter((f) => f.startsWith("mada.db")),
          "mada.db* files in MADA_DATA_DIR: the server wrote to SQLite",
        ).toEqual([]);
        expect(entries, "MADA_DATA_DIR holds recordings only").toEqual(["recordings"]);

        // The upload's row is in Postgres.
        const rows = await db.query(`SELECT "recordingId", seq, bytes FROM segments WHERE "recordingId" = $1`, [rid]);
        expect(rows).toEqual([{ recordingId: rid, seq: 3, bytes: audio.length }]);
      }),
    SERVER_START_MS + 60_000,
  );
});
