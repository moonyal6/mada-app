import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  SERVER_START_MS,
  createTestDb,
  makeDataDir,
  request,
  startServer,
  withCleanup,
  type Server,
  type TestDb,
} from "./pg/harness.mjs";

// I1–I7 of #9 (9b: every query asks for its clinic), written before the
// implementation, in a separate session, from the approved spec
// (issuecomment-6830668087). All are red on main except I6: the handout
// path is exempt from scoping, so it already works across clinics.
//
// Setup: one database and two servers, each on its own port with its own
// data directory. Server A runs as c1 (the seeded clinic); server B runs as
// c2, which the test inserts with SQL. Each test gets a fresh pair.
//
// A cross-clinic id must get the same response a missing id gets today
// (404), except creating an appointment or invoice under another clinic's
// patient: 9a's composite FK already rejects that, with a 500 (#25), so I4
// only asks that it is rejected and writes nothing.

/** The nine clinic-scoped tables. */
const SCOPED = [
  "patients",
  "appointments",
  "invoices",
  "inventory",
  "sessions",
  "recordings",
  "segments",
  "adherence",
  "pain_logs",
] as const;
type Scoped = (typeof SCOPED)[number];

/** Each table's primary key, as stored. */
const PK: Record<Scoped, string[]> = {
  patients: ["id"],
  appointments: ["id"],
  invoices: ["id"],
  inventory: ["id"],
  sessions: ["id"],
  recordings: ["id"],
  segments: ["recordingId", "seq"],
  adherence: ["sessionId", "day", "exIdx"],
  pain_logs: ["sessionId", "day"],
};

const NOW = "2026-11-14T09:00:00.000Z";

/** The seeded clinic's demo patient (fixed id in the seed). */
const SEEDED_PATIENT = { id: "p1", name: "محمد عبدالله العتيبي" };

/** What the handout page shows for an unknown token. */
const BAD_LINK = "الرابط غير صحيح";

const EXERCISE = { "back-bridge": { ar: "تمرين", en: "Bridge", desc: "", url: "", source: "case" } };

const q = (name: string) => `"${name}"`;
const keyExpr = (table: Scoped) => PK[table].map((c) => `${q(c)}::text`).join(` || '|' || `);
const sorted = (xs: string[]) => [...xs].sort();
const ids = (list: { id: string }[]) => sorted(list.map((x) => x.id));

/** The clinic's calendar date, as lib/server/db.ts's clinicToday() computes it. */
function clinicToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type Ctx = {
  db: TestDb;
  /** Server A, MADA_CLINIC_ID=c1. */
  a: Server;
  /** Server B, MADA_CLINIC_ID=c2. */
  b: Server;
  dataA: string;
  dataB: string;
};

/**
 * One fresh database, migrated and seeded (c1) by server A's first request;
 * then c2 is inserted with SQL and server B starts as c2. Both servers stay
 * up for `fn`.
 */
function withTwoClinics<T>(fn: (ctx: Ctx) => Promise<T>) {
  return withCleanup(async (defer) => {
    const db = await createTestDb();
    defer(db.drop);
    const dataA = makeDataDir();
    defer(() => rmSync(dataA, { recursive: true, force: true }));
    const dataB = makeDataDir();
    defer(() => rmSync(dataB, { recursive: true, force: true }));

    const a = await startServer({ dataDir: dataA, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "c1" } });
    defer(a.stop);
    const first = await request(a.base, "GET", "/api/patients");
    expect(first.status, `migrating start, GET /api/patients on A: ${JSON.stringify(first.body).slice(0, 300)}`).toBe(200);

    await db.query(`INSERT INTO clinics(id, name, "createdAt") VALUES ('c2', $1, $2)`, ["عيادة الاختبار الثانية", NOW]);
    const b = await startServer({ dataDir: dataB, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "c2" } });
    defer(b.stop);

    return fn({ db, a, b, dataA, dataB });
  });
}

/** A request that must succeed with `status`; used to build fixtures and for controls. */
async function call(
  server: Server,
  method: string,
  url: string,
  opts: Parameters<typeof request>[3],
  status: number,
) {
  const res = await request(server.base, method, url, opts);
  expect(res.status, `${method} ${url}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(status);
  return res.body;
}

/** Waits until every segment of the recording has stopped moving (done or failed). */
async function segmentsSettled(db: TestDb, recordingId: string) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const rows = await db.query(`SELECT status FROM segments WHERE "recordingId"=$1`, [recordingId]);
    if (rows.length > 0 && rows.every((r) => r.status === "done" || r.status === "failed")) return;
    if (Date.now() > deadline) throw new Error(`segments of ${recordingId} still pending: ${JSON.stringify(rows)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Data in both clinics, each made through its own server's API (9a already
 * stamps every insert with the server's clinic).
 *
 * A (c1): the seed (p1–p3, a1–a3, i1, n1–n4), plus on p1 a consented draft
 * session sA1 with an exercise, a recording rA with segment 0 (settled), a
 * second draft session sA2 without consent, and an unpaid invoice iA.
 *
 * B (c2): patient pB with an appointment today and one on another date, a
 * paid invoice, a low-stock inventory item, and a finished session sB with
 * an exercise (its finish adds an unpaid invoice).
 */
async function buildFixtures({ db, a, b }: Ctx) {
  const today = clinicToday();

  const sA1 = (await call(a, "POST", "/api/sessions", { body: { patientId: SEEDED_PATIENT.id } }, 201)).session;
  await call(a, "PATCH", `/api/sessions/${sA1.id}`, { body: { selected: EXERCISE } }, 200);
  await call(a, "POST", `/api/sessions/${sA1.id}/consent`, {}, 200);
  const rA: string = (await call(a, "POST", "/api/recordings", { body: { sessionId: sA1.id, mime: "audio/webm" } }, 201)).id;
  await call(a, "PUT", `/api/recordings/${rA}/segments/0`, { raw: new Uint8Array(2048).fill(7) }, 200);
  const sA2 = (await call(a, "POST", "/api/sessions", { body: { patientId: SEEDED_PATIENT.id } }, 201)).session;
  const iA = (await call(a, "POST", "/api/invoices", { body: { patientId: SEEDED_PATIENT.id, desc: "جلسة", amount: 120 } }, 201)).invoice;

  const pBName = "مريض العيادة الثانية";
  const pB = (await call(b, "POST", "/api/patients", { body: { name: pBName, caseKey: "back" } }, 201)).patient;
  const apB = (await call(b, "POST", "/api/appointments", { body: { patientId: pB.id, date: today, time: "13:00", type: "تقييم" } }, 201)).appointment;
  await call(b, "POST", "/api/appointments", { body: { patientId: pB.id, date: "2030-01-15", time: "09:00", type: "متابعة" } }, 201);
  const iBPaid = (await call(b, "POST", "/api/invoices", { body: { patientId: pB.id, desc: "جلسة", amount: 450, paid: true } }, 201)).invoice;
  const nB = (await call(b, "POST", "/api/inventory", { body: { name: "رباط مطاطي", qty: 1, min: 4 } }, 201)).item;
  const sB = (await call(b, "POST", "/api/sessions", { body: { patientId: pB.id } }, 201)).session;
  await call(b, "PATCH", `/api/sessions/${sB.id}`, { body: { selected: EXERCISE } }, 200);
  await call(b, "POST", `/api/sessions/${sB.id}/finish`, {}, 200);

  // Nothing may still be transcribing when a test snapshots A's rows, or
  // when B's transcription queue starts and recovers pending segments.
  await segmentsSettled(db, rA);

  return {
    today,
    pA: SEEDED_PATIENT,
    sA1: { id: sA1.id as string, token: sA1.handoutToken as string },
    sA2: { id: sA2.id as string },
    rA,
    iA: iA.id as string,
    aA: "a1",
    nA: "n1",
    pB: { id: pB.id as string, name: pBName },
    apB: apB.id as string,
    iBPaid: iBPaid.id as string,
    nB: nB.id as string,
    sB: { id: sB.id as string, token: sB.handoutToken as string },
  };
}

/** Every row of the clinic in the nine tables, ordered by key. */
async function clinicRows(db: TestDb, clinic: string) {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of SCOPED) {
    out[table] = await db.query(`SELECT * FROM ${table} WHERE clinic_id=$1 ORDER BY ${keyExpr(table)}`, [clinic]);
  }
  return out;
}

/** Row count of each scoped table, all clinics. */
async function rowCounts(db: TestDb) {
  const out: Record<string, number> = {};
  for (const table of SCOPED) {
    out[table] = (await db.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
  }
  return out;
}

describe("every query asks for its clinic (#9, 9b)", () => {
  it(
    "I1: every list endpoint shows each server only its own clinic's ids",
    () =>
      withTwoClinics(async (ctx) => {
        const { db, a, b } = ctx;
        const f = await buildFixtures(ctx);
        const otherPatient = { c1: f.pB.id, c2: f.pA.id };
        const ownPatient = { c1: f.pA.id, c2: f.pB.id };

        const sqlIds = async (sql: string, params: unknown[]) =>
          sorted((await db.query(sql, params)).map((r) => r.id as string));

        /** What the server for `clinic` should list: the clinic's own rows, from SQL. */
        const want = async (clinic: "c1" | "c2") => {
          const own = ownPatient[clinic];
          const patients = await sqlIds(`SELECT id FROM patients WHERE clinic_id=$1`, [clinic]);
          const todaysAppts = await db.query(
            `SELECT id, status FROM appointments WHERE clinic_id=$1 AND date=$2`,
            [clinic, f.today],
          );
          const inventory = await db.query(`SELECT id, qty, min FROM inventory WHERE clinic_id=$1`, [clinic]);
          const lowStock = sorted(inventory.filter((i) => i.qty <= i.min).map((i) => i.id));
          const [{ income }] = await db.query(
            `SELECT COALESCE(SUM(total), 0)::float AS income FROM invoices WHERE clinic_id=$1 AND paid=1`,
            [clinic],
          );
          const [{ n: finals }] = await db.query(
            `SELECT count(*)::int AS n FROM sessions WHERE clinic_id=$1 AND status='final'`,
            [clinic],
          );
          return {
            "GET /api/patients": patients,
            "GET /api/appointments": await sqlIds(`SELECT id FROM appointments WHERE clinic_id=$1`, [clinic]),
            "GET /api/appointments?date=today": sorted(todaysAppts.map((r) => r.id)),
            "GET /api/invoices": await sqlIds(`SELECT id FROM invoices WHERE clinic_id=$1`, [clinic]),
            "GET /api/inventory": sorted(inventory.map((r) => r.id)),
            "GET /api/sessions": await sqlIds(`SELECT id FROM sessions WHERE clinic_id=$1`, [clinic]),
            "GET /api/sessions?patientId=own patient": await sqlIds(
              `SELECT id FROM sessions WHERE clinic_id=$1 AND "patientId"=$2`,
              [clinic, own],
            ),
            "GET /api/sessions?patientId=other clinic's patient": [],
            // /api/invoices takes no patientId; listInvoices(patientId) is
            // reached through the patient detail.
            "GET /api/patients/own patient → invoices": await sqlIds(
              `SELECT id FROM invoices WHERE clinic_id=$1 AND "patientId"=$2`,
              [clinic, own],
            ),
            "GET /api/patients/own patient → sessions": await sqlIds(
              `SELECT id FROM sessions WHERE clinic_id=$1 AND "patientId"=$2`,
              [clinic, own],
            ),
            "GET /api/patients/own patient → appointments": await sqlIds(
              `SELECT id FROM appointments WHERE clinic_id=$1 AND "patientId"=$2`,
              [clinic, own],
            ),
            "GET /api/dashboard": {
              patients: patients,
              todaysAppts: sorted(todaysAppts.map((r) => r.id)),
              sessionsCount: finals,
              income,
              lowStock,
              counts: {
                patients: patients.length,
                apptsToday: todaysAppts.filter((r) => r.status === "محجوز").length,
                lowStock: lowStock.length,
              },
            },
            "GET /api/followup": await sqlIds(`SELECT id FROM patients WHERE clinic_id=$1 AND status <> 'منتهٍ'`, [clinic]),
          };
        };

        /** What the server actually lists. */
        const seen = async (server: Server, clinic: "c1" | "c2") => {
          const get = (url: string) => call(server, "GET", url, {}, 200);
          const own = ownPatient[clinic];
          const detail = await get(`/api/patients/${own}`);
          const dash = await get("/api/dashboard");
          return {
            "GET /api/patients": ids((await get("/api/patients")).patients),
            "GET /api/appointments": ids((await get("/api/appointments")).appointments),
            "GET /api/appointments?date=today": ids((await get(`/api/appointments?date=${f.today}`)).appointments),
            "GET /api/invoices": ids((await get("/api/invoices")).invoices),
            "GET /api/inventory": ids((await get("/api/inventory")).inventory),
            "GET /api/sessions": ids((await get("/api/sessions")).sessions),
            "GET /api/sessions?patientId=own patient": ids((await get(`/api/sessions?patientId=${own}`)).sessions),
            "GET /api/sessions?patientId=other clinic's patient": ids(
              (await get(`/api/sessions?patientId=${otherPatient[clinic]}`)).sessions,
            ),
            "GET /api/patients/own patient → invoices": ids(detail.invoices),
            "GET /api/patients/own patient → sessions": ids(detail.sessions),
            "GET /api/patients/own patient → appointments": ids(detail.appointments),
            "GET /api/dashboard": {
              patients: ids(dash.patients),
              todaysAppts: ids(dash.todaysAppts),
              sessionsCount: dash.sessionsCount,
              income: dash.income,
              lowStock: ids(dash.lowStock),
              counts: dash.counts,
            },
            "GET /api/followup": sorted(
              ((await get("/api/followup")).rows as { patient: { id: string } }[]).map((r) => r.patient.id),
            ),
          };
        };

        // Both clinics have rows in every listed table, so an unscoped list
        // can't pass by accident.
        const wantA = await want("c1");
        const wantB = await want("c2");
        for (const [clinic, lists] of Object.entries({ c1: wantA, c2: wantB })) {
          for (const [label, list] of Object.entries(lists)) {
            if (Array.isArray(list) && !label.includes("other clinic")) {
              expect(list.length, `fixture: ${clinic} has rows for ${label}`).toBeGreaterThan(0);
            }
          }
        }

        expect({ "A (c1)": await seen(a, "c1"), "B (c2)": await seen(b, "c2") }).toEqual({
          "A (c1)": wantA,
          "B (c2)": wantB,
        });
      }),
    2 * SERVER_START_MS + 120_000,
  );

  it(
    "I2: B's GET on A's patient, session or recording is 404",
    () =>
      withTwoClinics(async (ctx) => {
        const { a, b } = ctx;
        const f = await buildFixtures(ctx);
        const urls = {
          patient: `/api/patients/${f.pA.id}`,
          session: `/api/sessions/${f.sA1.id}`,
          recording: `/api/recordings/${f.rA}`,
        };
        const status = async (server: Server, url: string) => (await request(server.base, "GET", url)).status;

        const actual: Record<string, number> = {};
        const expected: Record<string, number> = {};
        for (const [what, url] of Object.entries(urls)) {
          // Control: the id exists, for its own clinic.
          expected[`A GET own ${what}`] = 200;
          actual[`A GET own ${what}`] = await status(a, url);
          expected[`B GET A's ${what}`] = 404;
          actual[`B GET A's ${what}`] = await status(b, url);
        }
        expected["B GET own patient"] = 200;
        actual["B GET own patient"] = await status(b, `/api/patients/${f.pB.id}`);
        expected["B GET own session"] = 200;
        actual["B GET own session"] = await status(b, `/api/sessions/${f.sB.id}`);

        expect(actual).toEqual(expected);
      }),
    2 * SERVER_START_MS + 60_000,
  );

  it(
    "I3: B's writes on A's ids are 404, A's rows are unchanged, and the cross-clinic finish creates no invoice",
    () =>
      withTwoClinics(async (ctx) => {
        const { db, b } = ctx;
        const f = await buildFixtures(ctx);

        // Each of these would change A's row if it went through: a1 is
        // booked, iA unpaid, sA2 a draft without consent, rA's segment 0
        // failed.
        const before = await clinicRows(db, "c1");
        expect(before.appointments.find((r) => r.id === f.aA)?.status, "fixture: a1 booked").toBe("محجوز");
        expect(before.invoices.find((r) => r.id === f.iA)?.paid, "fixture: iA unpaid").toBe(0);
        expect(before.sessions.find((r) => r.id === f.sA2.id), "fixture: sA2 draft, no consent").toMatchObject({
          status: "draft",
          consentAt: null,
        });
        const [{ n: invoicesBefore }] = await db.query(`SELECT count(*)::int AS n FROM invoices`);

        const calls: [string, string, Parameters<typeof request>[3]][] = [
          ["PATCH", `/api/appointments/${f.aA}`, { body: { status: "ملغى" } }],
          ["PATCH", `/api/invoices/${f.iA}`, { body: { paid: true } }],
          ["PATCH", `/api/inventory/${f.nA}`, { body: { delta: 5 } }],
          ["PATCH", `/api/sessions/${f.sA2.id}`, { body: { dialogue: "نص من عيادة أخرى" } }],
          ["POST", `/api/sessions/${f.sA2.id}/consent`, {}],
          ["POST", `/api/sessions/${f.sA2.id}/finish`, {}],
          ["POST", `/api/recordings/${f.rA}/segments/0/retry`, {}],
        ];
        const actual: Record<string, number> = {};
        const expected: Record<string, number> = {};
        for (const [method, url, opts] of calls) {
          expected[`B ${method} ${url}`] = 404;
          actual[`B ${method} ${url}`] = (await request(b.base, method, url, opts)).status;
        }

        // Controls: the same bodies are accepted on B's own ids, so each
        // 404 above is about the clinic, not the request.
        expected["control: B PATCH own appointment"] = 200;
        actual["control: B PATCH own appointment"] = (await request(b.base, "PATCH", `/api/appointments/${f.apB}`, { body: { status: "ملغى" } })).status;
        expected["control: B PATCH own inventory item"] = 200;
        actual["control: B PATCH own inventory item"] = (await request(b.base, "PATCH", `/api/inventory/${f.nB}`, { body: { delta: 5 } })).status;
        expected["control: B PATCH own invoice"] = 200;
        actual["control: B PATCH own invoice"] = (await request(b.base, "PATCH", `/api/invoices/${f.iBPaid}`, { body: { paid: true } })).status;

        const [{ n: invoicesAfter }] = await db.query(`SELECT count(*)::int AS n FROM invoices`);
        const after = await clinicRows(db, "c1");
        expect({
          statuses: actual,
          "invoices created": invoicesAfter - invoicesBefore,
          "tables where A's rows changed": SCOPED.filter((t) => !isDeepStrictEqual(after[t], before[t])),
        }).toEqual({ statuses: expected, "invoices created": 0, "tables where A's rows changed": [] });
        expect(after, "A's rows, all nine tables").toEqual(before);
      }),
    2 * SERVER_START_MS + 60_000,
  );

  it(
    "I4: B creating a child under A's patient, session or recording is refused and writes nothing",
    () =>
      withTwoClinics(async (ctx) => {
        const { db, b, dataA, dataB } = ctx;
        const f = await buildFixtures(ctx);
        const countsBefore = await rowCounts(db);

        const post = (url: string, body: unknown) => request(b.base, "POST", url, { body });
        const session = await post("/api/sessions", { patientId: f.pA.id });
        const recording = await post("/api/recordings", { sessionId: f.sA1.id, mime: "audio/webm" });
        const segment = await request(b.base, "PUT", `/api/recordings/${f.rA}/segments/7`, {
          raw: new Uint8Array(2048).fill(7),
        });
        const appointment = await post("/api/appointments", {
          patientId: f.pA.id,
          date: f.today,
          time: "15:00",
          type: "تقييم",
        });
        const invoice = await post("/api/invoices", { patientId: f.pA.id, desc: "جلسة", amount: 90 });

        const segmentRows = await db.query(`SELECT seq FROM segments WHERE "recordingId"=$1 AND seq=7`, [f.rA]);
        const segFiles = (dir: string) => {
          const recDir = path.join(dir, "recordings", f.rA);
          return existsSync(recDir) ? readdirSync(recDir).filter((n) => n.startsWith("7.")) : [];
        };

        expect(
          {
            "POST /api/sessions with A's patient": session.status,
            "POST /api/recordings on A's session": recording.status,
            "PUT segment 7 on A's recording": segment.status,
            "segment 7 row": segmentRows.length,
            "segment 7 file in A's data dir": segFiles(dataA),
            "A's recording dir in B's data dir": existsSync(path.join(dataB, "recordings", f.rA)),
            // Rejected by 9a's composite FK, today with a 500 (#25).
            "POST /api/appointments with A's patient rejected": appointment.status >= 400,
            "POST /api/invoices with A's patient rejected": invoice.status >= 400,
            "row counts, all clinics": await rowCounts(db),
          },
          JSON.stringify({ session: session.body, recording: recording.body, segment: segment.body }).slice(0, 600),
        ).toEqual({
          "POST /api/sessions with A's patient": 404,
          "POST /api/recordings on A's session": 404,
          "PUT segment 7 on A's recording": 404,
          "segment 7 row": 0,
          "segment 7 file in A's data dir": [],
          "A's recording dir in B's data dir": false,
          "POST /api/appointments with A's patient rejected": true,
          "POST /api/invoices with A's patient rejected": true,
          "row counts, all clinics": countsBefore,
        });

        // Controls: the same bodies with B's own patient are accepted.
        await call(b, "POST", "/api/sessions", { body: { patientId: f.pB.id } }, 201);
        await call(b, "POST", "/api/appointments", { body: { patientId: f.pB.id, date: f.today, time: "15:00", type: "تقييم" } }, 201);
        await call(b, "POST", "/api/invoices", { body: { patientId: f.pB.id, desc: "جلسة", amount: 90 } }, 201);
      }),
    2 * SERVER_START_MS + 60_000,
  );

  it(
    "I5: B's first patient gets file number 1042, and A's numbering is unaffected",
    () =>
      withTwoClinics(async ({ db, a, b }) => {
        const [{ n: c1Patients }] = await db.query(`SELECT count(*)::int AS n FROM patients WHERE clinic_id='c1'`);
        expect(c1Patients, "fixture: the seed's patients in c1").toBeGreaterThan(0);

        const create = async (server: Server, name: string) =>
          (await call(server, "POST", "/api/patients", { body: { name, caseKey: "back" } }, 201)).patient.fileNo;

        expect({
          "B's first patient": await create(b, "مريض أول في العيادة الثانية"),
          "A's next patient": await create(a, "مريض جديد في العيادة الأولى"),
          "B's second patient": await create(b, "مريض ثانٍ في العيادة الثانية"),
        }).toEqual({
          "B's first patient": "1042",
          "A's next patient": String(1042 + c1Patients),
          "B's second patient": "1043",
        });
      }),
    2 * SERVER_START_MS + 60_000,
  );

  it(
    "I6: handout tokens from both clinics work on either server, and log entries land in the session's own clinic",
    () =>
      withTwoClinics(async (ctx) => {
        const { db, a, b } = ctx;
        const f = await buildFixtures(ctx);
        const tokens = {
          "A's token": { token: f.sA1.token, patientName: f.pA.name },
          "B's token": { token: f.sB.token, patientName: f.pB.name },
        };
        const servers = { "server A": a, "server B": b };

        const actual: Record<string, unknown> = {};
        const expected: Record<string, unknown> = {};
        let pain = 2;
        for (const [serverLabel, server] of Object.entries(servers)) {
          for (const [tokenLabel, { token, patientName }] of Object.entries(tokens)) {
            const label = `${tokenLabel} on ${serverLabel}`;
            const page = await request(server.base, "GET", `/h/${token}`);
            const html = typeof page.body === "string" ? page.body : "";
            const check = await request(server.base, "POST", `/api/handout/${token}/log`, { body: { exIdx: 0, done: true } });
            const painLog = await request(server.base, "POST", `/api/handout/${token}/log`, { body: { pain: pain++ } });
            actual[label] = {
              page: page.status,
              "page shows the patient": html.includes(patientName) && !html.includes(BAD_LINK),
              "check-off": check.status,
              "pain log": painLog.status,
            };
            expected[label] = { page: 200, "page shows the patient": true, "check-off": 200, "pain log": 200 };
          }
        }
        expect(actual).toEqual(expected);

        const clinicOf = async (table: "adherence" | "pain_logs") =>
          Object.fromEntries(
            (await db.query(`SELECT DISTINCT "sessionId", clinic_id FROM ${table} ORDER BY 1`)).map((r) => [
              r.sessionId,
              r.clinic_id,
            ]),
          );
        const want = { [f.sA1.id]: "c1", [f.sB.id]: "c2" };
        expect({ adherence: await clinicOf("adherence"), pain_logs: await clinicOf("pain_logs") }).toEqual({
          adherence: want,
          pain_logs: want,
        });
      }),
    2 * SERVER_START_MS + 60_000,
  );

  it(
    "I7: with MADA_CLINIC_ID=nope, GET /api/patients fails and the log names nope",
    () =>
      withCleanup(async (defer) => {
        const db = await createTestDb();
        defer(db.drop);
        const dataDir = makeDataDir();
        defer(() => rmSync(dataDir, { recursive: true, force: true }));

        // A default start migrates and seeds, so the unknown clinic is the
        // only thing wrong with the second one.
        const first = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
        defer(first.stop);
        const ok = await request(first.base, "GET", "/api/patients");
        expect(ok.status, `migrating start: ${JSON.stringify(ok.body).slice(0, 200)}`).toBe(200);
        await first.stop();

        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "nope" } });
        defer(server.stop);
        const res = await request(server.base, "GET", "/api/patients");

        expect(
          {
            "GET /api/patients failed (5xx)": res.status >= 500,
            "the log names the clinic id": server.log().includes("nope"),
          },
          `GET → ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
        ).toEqual({
          "GET /api/patients failed (5xx)": true,
          "the log names the clinic id": true,
        });
      }),
    2 * SERVER_START_MS + 60_000,
  );
});
