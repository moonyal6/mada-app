import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVER_START_MS,
  createTestDb,
  makeDataDir,
  request,
  startServer,
  withCleanup,
  withServerOnFreshDb,
  type TestDb,
} from "./pg/harness.mjs";

// S1–S5 of #9 (9a: every row knows its clinic), written before the
// implementation, in a separate session, from the approved spec
// (issuecomment-6830668087). Each one is red on main.
//
// T1 in pg-migrations.test.ts describes the whole schema; these check what
// 9a promises: the column and its constraints (S1, S3), the backfill of an
// existing database (S2), that every insert path stamps the process's clinic
// (S4), and that an unknown clinic fails the request and writes nothing (S5).

const ROOT = fileURLToPath(new URL("..", import.meta.url));

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

/** Each table's primary key, as stored; `key()` below joins it into one value per row. */
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

/** The child → parent links the composite FKs guard, by the child's parent column. */
const CHILD_FKS: { table: Scoped; column: string; parent: "patients" | "sessions" | "recordings" }[] = [
  { table: "appointments", column: "patientId", parent: "patients" },
  { table: "invoices", column: "patientId", parent: "patients" },
  { table: "sessions", column: "patientId", parent: "patients" },
  { table: "recordings", column: "sessionId", parent: "sessions" },
  { table: "segments", column: "recordingId", parent: "recordings" },
  { table: "adherence", column: "sessionId", parent: "sessions" },
  { table: "pain_logs", column: "sessionId", parent: "sessions" },
];

const NOW = "2026-11-12T09:00:00.000Z";

const q = (name: string) => `"${name}"`;

/** One row per call: `INSERT INTO table("a","b") VALUES ($1,$2)`. */
function insert(db: TestDb, table: string, values: Record<string, unknown>) {
  const cols = Object.keys(values);
  return db.query(
    `INSERT INTO ${table}(${cols.map(q).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    Object.values(values),
  );
}

/** The Postgres error a statement fails with, or null when it succeeds. */
async function pgError(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (e) {
    const err = e as { code?: string; column?: string; detail?: string; message: string };
    return { code: err.code, column: err.column, detail: err.detail ?? "", message: err.message };
  }
}

/** A row's primary key as one string. */
function keyExpr(table: Scoped) {
  return PK[table].map((c) => `${q(c)}::text`).join(` || '|' || `);
}

/** Every row of every scoped table as `key → clinic_id`. */
async function clinicByKey(db: TestDb) {
  const out = {} as Record<Scoped, Record<string, string>>;
  for (const table of SCOPED) {
    const rows = await db.query(`SELECT ${keyExpr(table)} AS key, clinic_id FROM ${table}`);
    out[table] = Object.fromEntries(rows.map((r) => [r.key as string, r.clinic_id as string]));
  }
  return out;
}

/** Row count of each scoped table. */
async function rowCounts(db: TestDb) {
  const out: Record<string, number> = {};
  for (const table of SCOPED) {
    out[table] = (await db.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
  }
  return out;
}

/**
 * A fresh database migrated (and seeded) by one default server start, which
 * is stopped again before `fn` runs. The data directory is kept for a second
 * server.
 */
function withMigratedDb<T>(
  fn: (ctx: { db: TestDb; dataDir: string; defer: (cleanup: () => unknown) => void }) => Promise<T>,
) {
  return withCleanup(async (defer) => {
    const db = await createTestDb();
    defer(db.drop);
    const dataDir = makeDataDir();
    defer(() => rmSync(dataDir, { recursive: true, force: true }));
    const first = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
    defer(first.stop);
    const res = await request(first.base, "GET", "/api/patients");
    expect(res.status, `migrating start, GET /api/patients: ${JSON.stringify(res.body)}`).toBe(200);
    await first.stop();
    return fn({ db, dataDir, defer });
  });
}

const addClinic2 = (db: TestDb) =>
  insert(db, "clinics", { id: "c2", name: "عيادة الاختبار الثانية", createdAt: NOW });

describe("clinic_id across the schema (#9, 9a)", () => {
  it(
    "S1: a fresh database has clinics = {c1}, clinic_id text NOT NULL with no default and an FK to clinics on all nine tables, and both migrations in the ledger",
    () =>
      withServerOnFreshDb(async ({ db, server }) => {
        const res = await request(server.base, "GET", "/api/patients");
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        const columns = await db.query(
          `SELECT c.relname AS "table", format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS "notNull",
                  pg_get_expr(d.adbin, d.adrelid) AS "default",
                  EXISTS (
                    SELECT 1 FROM pg_constraint con
                    JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = con.confkey[1]
                    WHERE con.contype = 'f' AND con.conrelid = c.oid
                      AND con.conkey = ARRAY[a.attnum] AND con.confrelid = to_regclass('public.clinics')
                      AND array_length(con.confkey, 1) = 1 AND ra.attname = 'id'
                  ) AS "fkToClinics"
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
           LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'clinic_id' AND NOT a.attisdropped
           LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
           WHERE c.relname = ANY($1)`,
          [[...SCOPED]],
        );
        const actual = Object.fromEntries(
          columns.map(({ table, ...col }) => [table, col]),
        );
        const want = { type: "text", notNull: true, default: null, fkToClinics: true };
        expect(actual, "clinic_id on each scoped table").toEqual(
          Object.fromEntries(SCOPED.map((t) => [t, want])),
        );

        expect(await db.query(`SELECT id, name FROM clinics ORDER BY id`), "clinics").toEqual([
          { id: "c1", name: "عيادة العلاج الطبيعي" },
        ]);

        const ledger = await db.query(`SELECT name FROM schema_migrations ORDER BY name`);
        expect(ledger.map((r) => r.name), "schema_migrations").toEqual(["0001_init.sql", "0002_clinics.sql", "0003_rls.sql"]);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "S2: on a database as 8d9d6f0 left it, every existing row is backfilled to c1 with its other values unchanged",
    () =>
      withCleanup(async (defer) => {
        const db = await createTestDb();
        defer(db.drop);
        const dataDir = makeDataDir();
        defer(() => rmSync(dataDir, { recursive: true, force: true }));

        // The state 8d9d6f0 left a database in: 0001_init.sql applied and
        // recorded by that commit's runner, whose ledger DDL this is.
        const conn = await db.connect();
        try {
          await conn.query(readFileSync(path.join(ROOT, "migrations", "0001_init.sql"), "utf8"));
          await conn.query(`CREATE TABLE schema_migrations(name text PRIMARY KEY, "appliedAt" text NOT NULL)`);
          await conn.query(`INSERT INTO schema_migrations(name, "appliedAt") VALUES ('0001_init.sql', '${NOW}')`);
        } finally {
          await conn.end();
        }

        // Rows in every table, with non-default values where a column has a
        // default. No segment is `uploaded` or `transcribing`, so the
        // transcription queue's startup recovery leaves them alone; patients
        // is not empty, so the seed doesn't run.
        const rows: [Scoped, Record<string, unknown>][] = [
          ["patients", { id: "px1", name: "مريض أول", phone: "0500000001", fileNo: "2001", age: 41, sex: "ذكر", caseKey: "back", complaint: "شكوى", status: "متابعة", createdAt: NOW }],
          ["patients", { id: "px2", name: "مريضة ثانية", caseKey: "neckstrain", createdAt: "2026-11-11T08:00:00.000Z" }],
          ["appointments", { id: "ax1", patientId: "px1", date: "2026-11-20", time: "09:30", type: "متابعة", status: "تم" }],
          ["appointments", { id: "ax2", patientId: "px2", date: "2026-11-21", time: "11:00", type: "تقييم" }],
          ["invoices", { id: "ix1", patientId: "px1", date: "2026-11-12", items: '[{"desc":"جلسة","amount":250}]', total: 250.5, paid: 1 }],
          ["inventory", { id: "nx1", name: "رباط ضاغط", qty: 7, min: 2, unit: "علبة" }],
          ["inventory", { id: "nx2", name: "كمادات" }],
          ["sessions", { id: "sx1", patientId: "px1", status: "final", therapistName: "د. سارة", step: 3, dialogue: "حوار", dx: "تشخيص", date: "2026-11-12", selected: '{"back-bridge":{}}', suggestedDx: '["a"]', report: "تقرير", sealed: 1, sealDate: "2026-11-12", handoutToken: "tokx1", consentAt: NOW, createdAt: NOW, updatedAt: NOW, finishedAt: NOW }],
          ["sessions", { id: "sx2", patientId: "px2", date: "2026-11-11", handoutToken: "tokx2", createdAt: NOW, updatedAt: NOW }],
          ["recordings", { id: "rx1", sessionId: "sx1", mime: "audio/webm", startedAt: NOW }],
          ["segments", { recordingId: "rx1", seq: 0, status: "done", text: "نص", bytes: 1234, preferred: "local", provider: "local", note: "ملاحظة", createdAt: NOW, updatedAt: NOW }],
          ["segments", { recordingId: "rx1", seq: 1, status: "failed", error: "خطأ", bytes: 99, createdAt: NOW, updatedAt: NOW }],
          ["adherence", { sessionId: "sx1", day: "2026-11-12", exIdx: 0, done: 0, updatedAt: NOW }],
          ["pain_logs", { sessionId: "sx1", day: "2026-11-12", pain: 4, updatedAt: NOW }],
        ];
        for (const [table, values] of rows) await insert(db, table, values);
        const counts = await rowCounts(db);
        for (const table of SCOPED) expect(counts[table], `${table}: rows before the migration`).toBeGreaterThan(0);

        const before: Record<string, Record<string, unknown>[]> = {};
        for (const table of SCOPED) before[table] = await db.query(`SELECT * FROM ${table} ORDER BY ${keyExpr(table)}`);

        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
        defer(server.stop);
        const res = await request(server.base, "GET", "/api/patients");
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        for (const table of SCOPED) {
          const after = await db.query(`SELECT * FROM ${table} ORDER BY ${keyExpr(table)}`);
          expect(
            after.map((r) => r.clinic_id),
            `${table}: clinic_id of every row`,
          ).toEqual(before[table].map(() => "c1"));
          expect(
            after.map((r) => Object.fromEntries(Object.entries(r).filter(([col]) => col !== "clinic_id"))),
            `${table}: every other value unchanged`,
          ).toEqual(before[table]);
        }
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "S3: raw inserts without clinic_id fail 23502, with an unknown clinic 23503, and a c2 child of a c1 parent 23503 on each of the seven links",
    () =>
      withMigratedDb(async ({ db }) => {
        await addClinic2(db);

        let seq = 0;
        /** A valid row for `table`, minus clinic_id, under the given parents. */
        const row = (table: Scoped, k: string, p: { patient: string; session: string; recording: string }) => {
          switch (table) {
            case "patients":
              return { id: `p_${k}`, name: `مريض ${k}`, caseKey: "back", createdAt: NOW };
            case "appointments":
              return { id: `a_${k}`, patientId: p.patient, date: "2026-11-20", time: "10:00", type: "متابعة" };
            case "invoices":
              return { id: `i_${k}`, patientId: p.patient, date: "2026-11-12" };
            case "inventory":
              return { id: `n_${k}`, name: `صنف ${k}` };
            case "sessions":
              return { id: `s_${k}`, patientId: p.patient, date: "2026-11-12", handoutToken: `tok_${k}`, createdAt: NOW, updatedAt: NOW };
            case "recordings":
              return { id: `r_${k}`, sessionId: p.session, startedAt: NOW };
            case "segments":
              return { recordingId: p.recording, seq: ++seq, createdAt: NOW, updatedAt: NOW };
            case "adherence":
              return { sessionId: p.session, day: `day_${k}`, exIdx: 0, updatedAt: NOW };
            case "pain_logs":
              return { sessionId: p.session, day: `day_${k}`, pain: 3, updatedAt: NOW };
          }
        };

        // Parents in each clinic, inserted the valid way.
        const parents = { c1: { patient: "", session: "", recording: "" }, c2: { patient: "", session: "", recording: "" } };
        for (const clinic of ["c1", "c2"] as const) {
          const p = parents[clinic];
          const k = `parent_${clinic}`;
          p.patient = `p_${k}`;
          p.session = `s_${k}`;
          p.recording = `r_${k}`;
          await insert(db, "patients", { ...row("patients", k, p), clinic_id: clinic });
          await insert(db, "sessions", { ...row("sessions", k, p), clinic_id: clinic });
          await insert(db, "recordings", { ...row("recordings", k, p), clinic_id: clinic });
        }

        const outcome = (err: Awaited<ReturnType<typeof pgError>>) =>
          err === null ? "inserted" : err.code === "23502" ? `23502 ${err.column}` : (err.code ?? err.message);

        const actual: Record<string, string> = {};
        const expected: Record<string, string> = {};
        const fkDetails: Record<string, string> = {};

        for (const table of SCOPED) {
          // Controls: the same rows succeed with the parent's own clinic, so
          // each failure below is about clinic_id and nothing else.
          for (const clinic of ["c1", "c2"] as const) {
            const label = `${table}: valid row in ${clinic}`;
            expected[label] = "inserted";
            actual[label] = outcome(
              await pgError(() => insert(db, table, { ...row(table, `ok_${clinic}`, parents[clinic]), clinic_id: clinic })),
            );
          }

          expected[`${table}: no clinic_id`] = "23502 clinic_id";
          actual[`${table}: no clinic_id`] = outcome(
            await pgError(() => insert(db, table, row(table, "none", parents.c1))),
          );

          expected[`${table}: clinic_id 'zz'`] = "23503";
          const zz = await pgError(() => insert(db, table, { ...row(table, "zz", parents.c1), clinic_id: "zz" }));
          actual[`${table}: clinic_id 'zz'`] = outcome(zz);
          // With no parent, only the FK to clinics can reject it.
          if ((table === "patients" || table === "inventory") && zz) {
            fkDetails[`${table}: clinic_id 'zz'`] = zz.detail;
          }
        }

        for (const { table, column } of CHILD_FKS) {
          const label = `${table}: c2 row whose ${column} is in c1`;
          expected[label] = "23503";
          const err = await pgError(() => insert(db, table, { ...row(table, "cross", parents.c1), clinic_id: "c2" }));
          actual[label] = outcome(err);
          if (err) fkDetails[label] = err.detail;
        }

        expect(actual).toEqual(expected);

        // The rejections come from the right constraint: the clinics FK for
        // an unknown clinic, the composite FK for a cross-clinic child.
        for (const table of ["patients", "inventory"]) {
          expect(fkDetails[`${table}: clinic_id 'zz'`], `${table}: rejected by the FK to clinics`).toMatch(
            /\(clinic_id\)=\(zz\).*"clinics"/,
          );
        }
        for (const { table, column, parent } of CHILD_FKS) {
          const label = `${table}: c2 row whose ${column} is in c1`;
          expect(fkDetails[label], `${label}: rejected by the composite FK to ${parent}`).toMatch(
            new RegExp(`\\("?${column}"?, clinic_id\\)=\\([^)]*, c2\\).*"${parent}"`),
          );
        }
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "S4: with MADA_CLINIC_ID=c2, every insert path writes its rows in c2 and nothing new in c1",
    () =>
      withMigratedDb(async ({ db, dataDir, defer }) => {
        await addClinic2(db);
        const before = await clinicByKey(db);
        for (const table of SCOPED) {
          expect(Object.values(before[table]).filter((c) => c !== "c1"), `${table}: rows outside c1 before`).toEqual([]);
        }

        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "c2" } });
        defer(server.stop);
        const base = server.base;
        const call = async (method: string, url: string, opts: Parameters<typeof request>[3], status: number) => {
          const res = await request(base, method, url, opts);
          expect(res.status, `${method} ${url}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(status);
          return res.body;
        };

        const patient = (await call("POST", "/api/patients", { body: { name: "مريض العيادة الثانية", caseKey: "back" } }, 201)).patient;
        await call("POST", "/api/appointments", { body: { patientId: patient.id, date: "2026-11-20", time: "10:00", type: "تقييم" } }, 201);
        await call("POST", "/api/invoices", { body: { patientId: patient.id, desc: "جلسة", amount: 200 } }, 201);
        await call("POST", "/api/inventory", { body: { name: "رباط مطاطي", qty: 5, min: 1 } }, 201);
        const session = (await call("POST", "/api/sessions", { body: { patientId: patient.id } }, 201)).session;
        await call("POST", `/api/sessions/${session.id}/consent`, {}, 200);
        const recordingId = (await call("POST", "/api/recordings", { body: { sessionId: session.id, mime: "audio/webm" } }, 201)).id;
        await call("PUT", `/api/recordings/${recordingId}/segments/0`, { raw: new Uint8Array(2048).fill(7) }, 200);
        await call(
          "PATCH",
          `/api/sessions/${session.id}`,
          { body: { selected: { "back-bridge": { ar: "تمرين", en: "Bridge", desc: "", url: "", source: "case" } } } },
          200,
        );
        await call("POST", `/api/sessions/${session.id}/finish`, {}, 200);
        await call("POST", `/api/handout/${session.handoutToken}/log`, { body: { exIdx: 0, done: true } }, 200);
        await call("POST", `/api/handout/${session.handoutToken}/log`, { body: { pain: 3 } }, 200);

        const after = await clinicByKey(db);
        const added: Record<string, string[]> = {};
        const c1After: Record<string, Record<string, string>> = {};
        const c1Before: Record<string, Record<string, string>> = {};
        for (const table of SCOPED) {
          added[table] = Object.entries(after[table])
            .filter(([k]) => !(k in before[table]))
            .map(([, clinic]) => clinic)
            .sort();
          c1After[table] = Object.fromEntries(Object.entries(after[table]).filter(([, c]) => c === "c1"));
          c1Before[table] = before[table];
        }

        // Finish creates the second invoice; the handout check-off and pain
        // log write one row each.
        expect(added, "clinic of each new row, per table").toEqual({
          patients: ["c2"],
          appointments: ["c2"],
          invoices: ["c2", "c2"],
          inventory: ["c2"],
          sessions: ["c2"],
          recordings: ["c2"],
          segments: ["c2"],
          adherence: ["c2"],
          pain_logs: ["c2"],
        });
        expect(c1After, "c1's rows: the same keys as before, nothing new").toEqual(c1Before);
      }),
    2 * SERVER_START_MS + 60_000,
  );

  it(
    "S5: with MADA_CLINIC_ID=nope, POST /api/patients fails, the log names nope, and no row counts change",
    () =>
      withMigratedDb(async ({ db, dataDir, defer }) => {
        // Only the write path: 9a leaves reads unscoped, so the GET half of
        // this check belongs to 9b (owner's decision, 2026-11-12).
        const before = await rowCounts(db);

        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url, MADA_CLINIC_ID: "nope" } });
        defer(server.stop);
        const post = await request(server.base, "POST", "/api/patients", {
          body: { name: "مريض بلا عيادة", caseKey: "back" },
        });

        expect(
          {
            "POST /api/patients failed (5xx)": post.status >= 500,
            "the log names the clinic id": server.log().includes("nope"),
          },
          `POST → ${post.status} ${JSON.stringify(post.body).slice(0, 200)}`,
        ).toEqual({
          "POST /api/patients failed (5xx)": true,
          "the log names the clinic id": true,
        });
        expect(await rowCounts(db), "row counts").toEqual(before);
      }),
    2 * SERVER_START_MS + 60_000,
  );
});
