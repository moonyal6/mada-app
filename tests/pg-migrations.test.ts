import { rmSync } from "node:fs";
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

// T1 and T2 of #30 (8b-2), written before the implementation. They start
// the server on an empty database, let its first request run the
// migrations, and read the result from the Postgres catalog.
//
// T1 was rewritten for #9 (PR 9-0, tests only) to describe the schema after
// 9a: 0001_init.sql followed by 0002_clinics.sql. It is red on main until 9a
// merges, by design.
//
// For #43 (PR 43-0, tests only) its constants gain what 0004_staff.sql
// builds: `staff` and `memberships`. Red on main until 43a merges, by design.
//
// For #45 (PR 45-0, tests only) its constants gain what 0005_login_codes.sql
// builds: `login_codes` and `login_events`, and their four indexes. Red on
// main until 45a merges, by design.

/** A column: its type as `format_type` prints it, NOT NULL, and the value its default produces. */
type Col = { type: string; notNull: boolean; default?: string | number; identity?: true };

const text = (def?: string): Col => ({ type: "text", notNull: true, ...(def === undefined ? {} : { default: def }) });
const int = (def?: number): Col => ({ type: "integer", notNull: true, ...(def === undefined ? {} : { default: def }) });
const nullableText: Col = { type: "text", notNull: false };
const nullableInt: Col = { type: "integer", notNull: false };
const tz: Col = { type: "timestamp with time zone", notNull: true };
const nullableTz: Col = { type: "timestamp with time zone", notNull: false };

/**
 * Today's SQLite schema (lib/server/db.ts at 0121936) with the four
 * later-added columns folded in, mapped as the spec says: TEXT → text,
 * INTEGER → integer, REAL → double precision. Columns are in table order:
 * `SELECT *` rows reach the API as they are, so the order is part of the
 * response. A primary-key column is NOT NULL, which Postgres enforces.
 *
 * `inventory.seq` is the one new column, and the only one whose place in the
 * table isn't fixed (`listInventory` names its columns). The spec doesn't say
 * `integer` or `bigint`, or ALWAYS or BY DEFAULT, so either is accepted.
 *
 * This is what 0001_init.sql builds; TABLES below adds 0002_clinics.sql.
 */
const TABLES_0001: Record<string, Record<string, Col>> = {
  patients: {
    id: text(),
    name: text(),
    phone: text(""),
    fileNo: text(""),
    age: nullableInt,
    sex: text(""),
    caseKey: text(),
    complaint: text(""),
    status: text("نشط"),
    createdAt: text(),
  },
  appointments: {
    id: text(),
    patientId: text(),
    date: text(),
    time: text(),
    type: text(),
    status: text("محجوز"),
  },
  invoices: {
    id: text(),
    patientId: text(),
    date: text(),
    items: text("[]"),
    total: { type: "double precision", notNull: true, default: 0 },
    paid: int(0),
  },
  inventory: {
    id: text(),
    name: text(),
    qty: int(0),
    min: int(0),
    unit: text("قطعة"),
  },
  sessions: {
    id: text(),
    patientId: text(),
    status: text("draft"),
    therapistName: text(""),
    step: int(0),
    dialogue: text(""),
    assessment: text(""),
    dx: text(""),
    date: text(),
    sessionsCount: text(""),
    frequency: text(""),
    home: text(""),
    follow: text(""),
    pain: text(""),
    advice: text(""),
    planNotes: text(""),
    selected: text("{}"),
    suggestedDx: text("[]"),
    report: text(""),
    sealed: int(0),
    sealDate: text(""),
    handoutToken: text(),
    consentAt: nullableText,
    createdAt: text(),
    updatedAt: text(),
    finishedAt: nullableText,
  },
  recordings: {
    id: text(),
    sessionId: text(),
    mime: text(""),
    startedAt: text(),
  },
  segments: {
    recordingId: text(),
    seq: int(),
    status: text("uploaded"),
    text: text(""),
    error: text(""),
    bytes: int(0),
    preferred: text(""),
    provider: text(""),
    note: text(""),
    createdAt: text(),
    updatedAt: text(),
  },
  adherence: {
    sessionId: text(),
    day: text(),
    exIdx: int(),
    done: int(1),
    updatedAt: text(),
  },
  pain_logs: {
    sessionId: text(),
    day: text(),
    pain: int(),
    updatedAt: text(),
  },
};

/** The nine clinic-scoped tables: every table 0001_init.sql builds (#9). */
const CLINIC_SCOPED = Object.keys(TABLES_0001);

/**
 * After 9a (#9): a `clinics` table, and `clinic_id text NOT NULL` with no
 * default as the last column of each of the nine tables. Without a default,
 * an insert that forgets the clinic fails instead of landing in `c1`.
 */
const TABLES: Record<string, Record<string, Col>> = {
  clinics: {
    id: text(),
    name: text(),
    createdAt: text(),
  },
  ...Object.fromEntries(
    Object.entries(TABLES_0001).map(([table, cols]) => [table, { ...cols, clinic_id: text() }]),
  ),
  // 0004_staff.sql (#43): an account, and its link to one clinic. Neither
  // has a default; phone and email are nullable (at least one is set).
  staff: {
    id: text(),
    name: text(),
    phone: nullableText,
    email: nullableText,
    createdAt: text(),
  },
  memberships: {
    staff_id: text(),
    clinic_id: text(),
    role: text(),
    createdAt: text(),
  },
  // 0005_login_codes.sql (#45): a login code's hash and lifetime, and the
  // ledger of requests and failed attempts the caps count. No defaults; only
  // used_at is nullable.
  login_codes: {
    id: { type: "bigint", notNull: true, identity: true },
    staff_id: text(),
    code_hash: text(),
    created_at: tz,
    expires_at: tz,
    used_at: nullableTz,
  },
  login_events: {
    id: { type: "bigint", notNull: true, identity: true },
    kind: text(),
    identifier: text(),
    ip: text(),
    at: tz,
  },
};

const PRIMARY_KEYS: Record<string, string[]> = {
  clinics: ["id"],
  staff: ["id"],
  memberships: ["staff_id", "clinic_id"],
  login_codes: ["id"],
  login_events: ["id"],
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

const NO_ACTION = "on delete no action on update no action";

/**
 * `table(columns) → table(columns)`, with no ON DELETE / ON UPDATE action, as
 * today. After 9a (#9) there are three kinds:
 *  - the seven single-column FKs from 0001, which stay;
 *  - `clinic_id → clinics(id)` on each of the nine tables;
 *  - seven composite FKs, (parent id, clinic_id) → parent(id, clinic_id), so a
 *    child row can't belong to a different clinic than its parent.
 */
const FOREIGN_KEYS = [
  `adherence(sessionId) → sessions(id) ${NO_ACTION}`,
  `appointments(patientId) → patients(id) ${NO_ACTION}`,
  `invoices(patientId) → patients(id) ${NO_ACTION}`,
  `pain_logs(sessionId) → sessions(id) ${NO_ACTION}`,
  `recordings(sessionId) → sessions(id) ${NO_ACTION}`,
  `segments(recordingId) → recordings(id) ${NO_ACTION}`,
  `sessions(patientId) → patients(id) ${NO_ACTION}`,

  ...CLINIC_SCOPED.map((table) => `${table}(clinic_id) → clinics(id) ${NO_ACTION}`),

  `appointments(patientId, clinic_id) → patients(id, clinic_id) ${NO_ACTION}`,
  `invoices(patientId, clinic_id) → patients(id, clinic_id) ${NO_ACTION}`,
  `sessions(patientId, clinic_id) → patients(id, clinic_id) ${NO_ACTION}`,
  `recordings(sessionId, clinic_id) → sessions(id, clinic_id) ${NO_ACTION}`,
  `segments(recordingId, clinic_id) → recordings(id, clinic_id) ${NO_ACTION}`,
  `adherence(sessionId, clinic_id) → sessions(id, clinic_id) ${NO_ACTION}`,
  `pain_logs(sessionId, clinic_id) → sessions(id, clinic_id) ${NO_ACTION}`,

  // 0004_staff.sql (#43).
  `memberships(staff_id) → staff(id) ${NO_ACTION}`,
  `memberships(clinic_id) → clinics(id) ${NO_ACTION}`,

  // 0005_login_codes.sql (#45).
  `login_codes(staff_id) → staff(id) ${NO_ACTION}`,
].sort();

/**
 * Uniqueness beyond the primary keys, as a constraint or a unique index.
 * 9a (#9) adds UNIQUE(id, clinic_id) on the three parents of the composite FKs.
 * 0004 (#43) adds a unique phone and email per account, and the one-clinic
 * rule, UNIQUE(staff_id) on memberships.
 */
const UNIQUE = [
  "sessions(handoutToken)",
  "patients(id, clinic_id)",
  "sessions(id, clinic_id)",
  "recordings(id, clinic_id)",
  "staff(phone)",
  "staff(email)",
  "memberships(staff_id)",
].sort();

/** The five migrations, in the order the runner applies them. */
const LEDGER = ["0001_init.sql", "0002_clinics.sql", "0003_rls.sql", "0004_staff.sql", "0005_login_codes.sql"];

/**
 * Indexes that back no constraint, in sorted order: the three from 0001, and
 * the four 0005 (#45) adds for the account's codes, the two caps and the prune.
 */
const INDEXES = [
  "idx_appts_date: appointments(date)",
  "idx_segments_status: segments(status)",
  "idx_sessions_patient: sessions(patientId)",
  "login_codes_staff_id_idx: login_codes(staff_id)",
  "login_events_at_idx: login_events(at)",
  "login_events_identifier_idx: login_events(kind, identifier, at)",
  "login_events_ip_idx: login_events(kind, ip, at)",
];

const FK_ACTION: Record<string, string> = {
  a: "no action",
  r: "restrict",
  c: "cascade",
  n: "set null",
  d: "set default",
};

/** What the migrations built in `public`, in the same shapes as the expectation above. */
async function readSchema(db: TestDb) {
  const tables = (
    await db.query(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`,
    )
  ).map((r) => r.relname as string);

  const columnRows = await db.query(
    `SELECT c.relname AS "table", a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS "notNull", pg_get_expr(d.adbin, d.adrelid) AS "defaultExpr",
            a.attidentity AS identity, a.attgenerated AS generated
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`,
  );
  const columns: Record<string, Record<string, Col & { generated?: string }>> = {};
  for (const r of columnRows) {
    const col: Col & { generated?: string } = { type: r.type, notNull: r.notNull };
    if (r.defaultExpr !== null) {
      // The value the default produces, not how it was spelled: `0`, `0.0`
      // and `'0'::double precision` are all 0. Read in a fresh connection to
      // the test's own database.
      col.default = (await db.query(`SELECT (${r.defaultExpr}) AS v`))[0].v;
    }
    if (r.identity) col.identity = true;
    if (r.generated) col.generated = r.generated;
    (columns[r.table] ??= {})[r.name] = col;
  }

  const constraints = await db.query(
    `SELECT con.contype, c.relname AS "table", fc.relname AS "refTable",
            con.confdeltype, con.confupdtype,
            ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
            ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                  JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) AS "refCols"
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_class fc ON fc.oid = con.confrelid
     WHERE n.nspname = 'public' AND con.contype IN ('p', 'f', 'u')`,
  );
  const primaryKeys: Record<string, string[]> = {};
  const foreignKeys: string[] = [];
  const unique: string[] = [];
  for (const r of constraints) {
    const cols = (r.cols as string[]).join(", ");
    if (r.contype === "p") primaryKeys[r.table] = r.cols;
    else if (r.contype === "u") unique.push(`${r.table}(${cols})`);
    else {
      foreignKeys.push(
        `${r.table}(${cols}) → ${r.refTable}(${(r.refCols as string[]).join(", ")})` +
          ` on delete ${FK_ACTION[r.confdeltype]} on update ${FK_ACTION[r.confupdtype]}`,
      );
    }
  }

  // Indexes that back no constraint. A unique one counts as uniqueness.
  const indexRows = await db.query(
    `SELECT ic.relname AS name, c.relname AS "table", i.indisunique AS "unique",
            i.indexprs IS NOT NULL AS "hasExpr", i.indpred IS NOT NULL AS partial, am.amname AS method,
            ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(n, j)
                  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.n ORDER BY k.j) AS cols
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_am am ON am.oid = ic.relam
     WHERE n.nspname = 'public'
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)`,
  );
  const indexes: string[] = [];
  for (const r of indexRows) {
    const on = `${r.table}(${(r.cols as string[]).join(", ")})`;
    if (r.unique) unique.push(on);
    else {
      const extra = [r.method !== "btree" && r.method, r.hasExpr && "expression", r.partial && "partial"].filter(Boolean);
      indexes.push(`${r.name}: ${on}${extra.length ? ` [${extra.join(", ")}]` : ""}`);
    }
  }

  return {
    tables,
    columns,
    primaryKeys,
    foreignKeys: foreignKeys.sort(),
    unique: unique.sort(),
    indexes: indexes.sort(),
  };
}

/**
 * Everything a second run could change, read raw from the catalog: object
 * OIDs (a table dropped and recreated gets a new one), every column including
 * dropped ones, constraint and index definitions, triggers, sequences, and
 * every row of schema_migrations.
 */
async function snapshot(db: TestDb) {
  return {
    relations: await db.query(
      `SELECT c.oid::int AS oid, c.relname, c.relkind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' ORDER BY c.relname`,
    ),
    columns: await db.query(
      `SELECT c.relname, a.attnum, a.attname, a.attisdropped, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull, a.attidentity, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) AS def
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0
       ORDER BY c.relname, a.attnum`,
    ),
    constraints: await db.query(
      `SELECT con.oid::int AS oid, c.relname, con.conname, pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' ORDER BY c.relname, con.conname`,
    ),
    indexes: await db.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
    ),
    triggers: await db.query(
      `SELECT c.relname, t.tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
    ),
    sequences: await db.query(
      `SELECT sequencename, data_type::text, start_value::text, increment_by::text
       FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename`,
    ),
    migrations: await db.query(`SELECT * FROM schema_migrations ORDER BY 1`),
  };
}

/** The first request runs startup, which migrates. */
async function migrateByRequest(base: string) {
  const res = await request(base, "GET", "/api/patients");
  expect(res.status, `GET /api/patients: ${JSON.stringify(res.body)}`).toBe(200);
}

describe("migrations on Postgres (#30, 8b-2)", () => {
  it(
    "T1: on an empty database they build exactly the schema after 9a: 0001 (with inventory.seq), then clinics and clinic_id",
    () =>
      withServerOnFreshDb(async ({ db, server }) => {
        await migrateByRequest(server.base);
        const schema = await readSchema(db);

        expect(schema.tables, "tables in public").toEqual([...Object.keys(TABLES), "schema_migrations"].sort());

        for (const [table, expected] of Object.entries(TABLES)) {
          const actual = { ...schema.columns[table] };
          if (table === "inventory") {
            const { seq, ...rest } = actual;
            expect(seq, "inventory.seq: an identity column, NOT NULL, no other default").toMatchObject({
              type: expect.stringMatching(/^(integer|bigint)$/),
              notNull: true,
              identity: true,
            });
            expect(seq).not.toHaveProperty("default");
            expect(seq).not.toHaveProperty("generated");
            expect(rest, "inventory columns besides seq").toEqual(expected);
            expect(Object.keys(rest), "inventory column order besides seq").toEqual(Object.keys(expected));
          } else {
            expect(actual, `${table} columns`).toEqual(expected);
            expect(Object.keys(actual), `${table} column order`).toEqual(Object.keys(expected));
          }
        }

        // clinic_id is the last column of every scoped table, inventory
        // included: after seq, which the check above sets aside.
        for (const table of CLINIC_SCOPED) {
          expect(Object.keys(schema.columns[table]).at(-1), `${table}: last column`).toBe("clinic_id");
        }

        const appKeys = Object.fromEntries(
          Object.entries(schema.primaryKeys).filter(([table]) => table !== "schema_migrations"),
        );
        expect(appKeys, "primary keys").toEqual(PRIMARY_KEYS);
        expect(schema.foreignKeys, "foreign keys").toEqual(FOREIGN_KEYS);
        expect(
          schema.unique.filter((u) => !u.startsWith("schema_migrations(")),
          "unique constraints and unique indexes",
        ).toEqual(UNIQUE);
        expect(schema.indexes, "indexes").toEqual(INDEXES);

        // The runner's own table: its columns are the implementation's
        // choice, but it holds exactly five migrations, 0001_init.sql,
        // 0002_clinics.sql, 0003_rls.sql (#10), 0004_staff.sql (#43) and
        // 0005_login_codes.sql (#45), one row each.
        const ledger = await db.query("SELECT * FROM schema_migrations");
        const names = ledger.map((row) =>
          Object.values(row).filter((v) => typeof v === "string" && v.endsWith(".sql")),
        );
        for (const n of names) expect(n, "each schema_migrations row names one migration").toHaveLength(1);
        expect(names.flat().sort(), "schema_migrations rows").toEqual(LEDGER);
      }),
    SERVER_START_MS + 60_000,
  );

  it(
    "T2: restarting the server on the same database changes nothing in the schema or schema_migrations",
    () =>
      withCleanup(async (defer) => {
        const db = await createTestDb();
        defer(db.drop);
        const dataDir = makeDataDir();
        defer(() => rmSync(dataDir, { recursive: true, force: true }));
        const env = { DATABASE_URL: db.url };

        const first = await startServer({ dataDir, env });
        defer(first.stop);
        await migrateByRequest(first.base);
        await first.stop();

        // Without this a run that migrated nothing would compare two empty
        // snapshots and pass.
        const tables = await db.query(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
        );
        expect(tables, "the first run created schema_migrations").toHaveLength(1);
        const before = await snapshot(db);
        expect(before.migrations.length, "the first run recorded a migration").toBeGreaterThan(0);
        expect(before.relations.length, "the first run created tables").toBeGreaterThan(1);

        const second = await startServer({ dataDir, env });
        defer(second.stop);
        await migrateByRequest(second.base);
        const after = await snapshot(db);

        expect(after).toEqual(before);
      }),
    2 * SERVER_START_MS + 60_000,
  );
});
