import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_ROLE,
  SERVER_START_MS,
  createTestDb,
  makeDataDir,
  request,
  startServer,
  testDatabaseUrl,
  withCleanup,
  type Server,
  type TestDb,
} from "./pg/harness.mjs";

// L13–L20 of #45 (login codes: issue and check), through `next start`,
// written before the implementation, in a separate session, from the
// approved spec (v2, with the approval's amendments 1 and 5). PR 45-0 ships
// them with no migration and no app code, so every one is red on main by
// design, until 45b merges (45a alone leaves them red: there is no route).
//
// What each does on main: the fixture inserts succeed, then the first
// POST /api/auth/code answers 404 (no such route), not 200, 400 or 503.
// L17's GETs answer 404 too, not 405.
//
// The tests import no app code: everything goes through HTTP or SQL. Each
// test starts one server (L20: five, one after another) on its own copy of a
// database migrated once in this file, with RAILWAY_ENVIRONMENT_NAME set to
// an empty string (which wins over any env file) unless the test is about
// that variable. Every request sets X-Real-IP, except where L16 says not.
//
// "The code for X" is read from the last `[login-code] to=X code=<8 digits>`
// line of the server's log, polled for up to 5 seconds. Time is never slept
// through: the database clock is the only clock, so a test moves rows into
// the past as admin (`ageCodes`, `ageEvents`).
//
// The harness's `request()` takes no headers, so this file has its own
// `send`. The database helpers follow the ones in pg-founder.test.ts, and
// nothing is shared.

/** One server on a template copy: the first test in a run also pays for the migrating server start. */
const ONE_SERVER_MS = 2 * SERVER_START_MS + 60_000;
/** L20: five more servers. */
const FIVE_SERVERS_MS = 6 * SERVER_START_MS + 120_000;

const NOW = "2026-11-26T09:00:00.000Z";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = Record<string, unknown>;
type Defer = (cleanup: () => unknown) => void;

/** A template copy: its app URL, its owner URL, and one statement as admin. */
type Db = {
  name: string;
  /** `mada_app` on it. */
  url: string;
  /** The admin on it. */
  ownerUrl: string;
  /** One statement as admin, on its own connection. */
  query: (sql: string, params?: unknown[]) => Promise<Row[]>;
};

/* ─── Databases ────────────────────────────────────────────────────────── */

/** Runs one statement on its own connection. */
async function runOn(connectionString: string, sql: string, params?: unknown[]): Promise<Row[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as Row[];
  } finally {
    await client.end();
  }
}

/** The one database a server migrates in this file; every test's database is a copy of it. */
let template: Promise<TestDb> | undefined;

/**
 * A fresh database migrated (and seeded with c1 and the demo rows) by one
 * server start and GET /api/patients. Built once, by the first test; a
 * failed build fails every test with the same error.
 */
function migratedTemplate(): Promise<TestDb> {
  template ??= (async () => {
    const db = await createTestDb();
    try {
      await withCleanup(async (defer) => {
        const dataDir = makeDataDir();
        defer(() => rmSync(dataDir, { recursive: true, force: true }));
        const server = await startServer({ dataDir, env: { DATABASE_URL: db.url } });
        defer(server.stop);
        const res = await request(server.base, "GET", "/api/patients");
        expect(
          res.status,
          `migrating start as ${APP_ROLE}, GET /api/patients: ${JSON.stringify(res.body).slice(0, 300)}`,
        ).toBe(200);
      });
    } catch (e) {
      await db.drop();
      throw e;
    }
    return db;
  })();
  return template;
}

/** A copy of `db` (CREATE DATABASE … TEMPLATE): schema, grants, policies and rows. */
async function copyOf(db: TestDb, suffix: string): Promise<Db & { drop: () => Promise<unknown> }> {
  const admin = testDatabaseUrl();
  const name = `${db.name}_${suffix}`;
  // A connection that has just closed can still hold the template for a
  // moment (55006: "being accessed by other users").
  for (let tries = 0; ; tries++) {
    try {
      await runOn(admin, `CREATE DATABASE ${name} TEMPLATE ${db.name}`);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "55006" || tries >= 20) throw e;
      await sleep(250);
    }
  }
  const withName = (url: string) => {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.href;
  };
  const ownerUrl = withName(db.ownerUrl);
  return {
    name,
    url: withName(db.url),
    ownerUrl,
    query: (sql, params) => runOn(ownerUrl, sql, params),
    drop: () => runOn(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/* ─── Fixture ──────────────────────────────────────────────────────────── */

const S1_PHONE = "+966500000001";
const S1_EMAIL = "s1@clinic.test";
const S2_PHONE = "+966500000002";
const S3_EMAIL = "s3@clinic.test";
const UNKNOWN_PHONE = "+966599999999";
const UNKNOWN_EMAIL = "nobody@clinic.test";

const STAFF = [
  { id: "s1", name: "موظف أول", phone: S1_PHONE, email: S1_EMAIL },
  { id: "s2", name: "موظف ثان", phone: S2_PHONE, email: null },
  { id: "s3", name: "موظف ثالث", phone: null, email: S3_EMAIL },
];

/** s3 has no membership. */
const MEMBERSHIPS = [
  { staff_id: "s1", clinic_id: "c1", role: "owner" },
  { staff_id: "s2", clinic_id: "c2", role: "therapist" },
];

/**
 * One test's database: a template copy, and as admin (c1 exists from 0002)
 * clinic c2, the three accounts and the two memberships. These inserts
 * succeed on main. `tag` keeps the copies' names apart.
 */
async function fixtureDb(defer: Defer, tag: string): Promise<Db> {
  const db = await copyOf(await migratedTemplate(), tag);
  defer(db.drop);
  await db.query(`INSERT INTO clinics(id, name, "createdAt") VALUES ($1, $2, $3)`, ["c2", "عيادة الاختبار الثانية", NOW]);
  for (const s of STAFF) {
    await db.query(`INSERT INTO staff(id, name, phone, email, "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
      s.id,
      s.name,
      s.phone,
      s.email,
      NOW,
    ]);
  }
  for (const m of MEMBERSHIPS) {
    await db.query(`INSERT INTO memberships(staff_id, clinic_id, role, "createdAt") VALUES ($1, $2, $3, $4)`, [
      m.staff_id,
      m.clinic_id,
      m.role,
      NOW,
    ]);
  }
  return db;
}

/** "Age codes by X": every code was issued, and expires, X earlier. */
const ageCodes = (db: Db, by: string) =>
  db.query(`UPDATE login_codes SET created_at = created_at - $1::interval, expires_at = expires_at - $1::interval`, [by]);

/** "Age events by X": every event happened X earlier. Codes stay alive. */
const ageEvents = (db: Db, by: string) => db.query(`UPDATE login_events SET at = at - $1::interval`, [by]);

/** How many rows each of the two tables holds. */
async function tableCounts(db: Db) {
  const [row] = await db.query(
    `SELECT (SELECT count(*)::int FROM login_codes) AS login_codes, (SELECT count(*)::int FROM login_events) AS login_events`,
  );
  return row;
}

/* ─── The server ───────────────────────────────────────────────────────── */

/**
 * `next start` on `db` as the app role, with the copy's owner URL (the
 * harness only knows the owner of databases it created itself) and the given
 * Railway environment name. Stopped, and its data directory removed, by
 * `defer`.
 */
async function startOn(db: Db, defer: Defer, environmentName = ""): Promise<Server> {
  const dataDir = makeDataDir();
  defer(() => rmSync(dataDir, { recursive: true, force: true }));
  const server = await startServer({
    dataDir,
    env: { DATABASE_URL: db.url, DATABASE_OWNER_URL: db.ownerUrl, RAILWAY_ENVIRONMENT_NAME: environmentName },
  });
  defer(server.stop);
  return server;
}

const REQUEST_ROUTE = "/api/auth/code";
const CHECK_ROUTE = "/api/auth/code/check";

type Answer = { status: number; text: string; contentType: string | null };

/**
 * One request with the given headers. `body`, when given, is sent as it is,
 * as application/json. Times out rather than hanging.
 */
async function send(
  base: string,
  method: "GET" | "POST",
  urlPath: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  const all: Record<string, string> = { ...headers };
  if (body !== undefined) all["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(base + urlPath, { method, headers: all, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new Error(`${method} ${urlPath} got no response within 15000 ms: ${(e as Error).message}`);
  }
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") };
}

const realIp = (ip: string) => ({ "X-Real-IP": ip });

/** The address most requests come from. */
const IP = realIp("198.51.100.1");

/** POST /api/auth/code with `{ identifier }`. */
const requestCode = (server: Server, identifier: unknown, headers: Record<string, string>) =>
  send(server.base, "POST", REQUEST_ROUTE, { headers, body: JSON.stringify({ identifier }) });

/** POST /api/auth/code/check with `{ identifier, code }`. */
const checkCode = (server: Server, identifier: unknown, code: unknown, headers: Record<string, string>) =>
  send(server.base, "POST", CHECK_ROUTE, { headers, body: JSON.stringify({ identifier, code }) });

/** An answer's status and body text. A long body (on main: Next's 404 page) is cut short. */
const told = (a: Answer) => ({ status: a.status, body: a.text.length > 200 ? `${a.text.slice(0, 200)}…` : a.text });
/** The same, with the content type. */
const toldFully = (a: Answer) => ({ ...told(a), contentType: a.contentType });
const isJson = (a: Answer) => (a.contentType ?? "").includes("application/json");

const OK = { status: 200, body: '{"ok":true}' };
const refusal = (status: number, error: string) => ({ status, body: `{"error":"${error}"}` });

/* ─── The log ──────────────────────────────────────────────────────────── */

const SENDER_PREFIX = "[login-code] ";

const logLines = (server: Server) => server.log().split(/\r?\n/);
/** The lines the log sender wrote. */
const senderLines = (server: Server) => logLines(server).filter((line) => line.startsWith(SENDER_PREFIX));
/** Any line that mentions the sender's tag, wherever it stands in the line. */
const taggedLines = (server: Server) => logLines(server).filter((line) => line.includes("[login-code]"));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "The code for X": from the last `[login-code] to=X code=<8 digits>` line
 * of the log, polled for up to 5 seconds. `count` is how many such lines
 * there must be by now, so a second request for X waits for its own line.
 */
async function codeFor(server: Server, to: string, count = 1): Promise<string> {
  const pattern = new RegExp(`^\\[login-code\\] to=${escapeRegExp(to)} code=(\\d{8})$`);
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = logLines(server)
      .map((line) => pattern.exec(line))
      .filter((m): m is RegExpExecArray => m !== null);
    if (found.length >= count) return found[found.length - 1][1];
    if (Date.now() > deadline) {
      throw new Error(
        `the log has ${found.length} line(s) "[login-code] to=${to} code=<8 digits>" after 5 s, not ${count}. ` +
          `Sender lines: ${JSON.stringify(senderLines(server))}`,
      );
    }
    await sleep(50);
  }
}

/** Whether the log has a line equal to `line`, polled for up to 5 seconds. */
async function logHasLine(server: Server, line: string): Promise<boolean> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (logLines(server).includes(line)) return true;
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
}

/**
 * The log rule (amendments 11 and 12): no log line other than the sender's
 * holds a code, an identifier or a hash. With every `[login-code] ` line
 * removed, the log must contain none of `codes` and, ignoring case, none of
 * `identifiers` and none of `hashes`. Called at the end of a test, once the
 * server is stopped, so the log is complete.
 */
function expectNothingOutsideSenderLines(
  server: Server,
  where: string,
  { codes = [], identifiers = [], hashes = [] }: { codes?: string[]; identifiers?: string[]; hashes?: string[] },
) {
  const rest = logLines(server)
    .filter((line) => !line.startsWith(SENDER_PREFIX))
    .join("\n");
  const lowered = rest.toLowerCase();
  expect(
    {
      "codes in the log outside the sender's lines": codes.filter((code) => rest.includes(code)).length,
      "identifiers in the log outside the sender's lines": identifiers.filter((identifier) =>
        lowered.includes(identifier.toLowerCase()),
      ),
      "code_hash values in the log outside the sender's lines": hashes.filter((hash) => lowered.includes(hash.toLowerCase())),
    },
    `${where}: the log without its "${SENDER_PREFIX}" lines:\n${rest}`,
  ).toEqual({
    "codes in the log outside the sender's lines": 0,
    "identifiers in the log outside the sender's lines": [],
    "code_hash values in the log outside the sender's lines": [],
  });
}

/** Every `code_hash` in `login_codes`, as admin. */
const storedHashes = async (db: Db) => (await db.query(`SELECT code_hash FROM login_codes ORDER BY id`)).map((r) => r.code_hash as string);

/* ─── Codes and digits ─────────────────────────────────────────────────── */

/** D4: lower-case hex SHA-256 of `mada-login-code/v1\n<normalised identifier>\n<code>`. */
const hashOver = (identifier: string, code: string) =>
  createHash("sha256").update(`mada-login-code/v1\n${identifier}\n${code}`, "utf8").digest("hex");

/** A well-formed code that is none of `issued`. */
function codeOtherThan(issued: string[]): string {
  for (let n = 0; ; n++) {
    const code = String(n).padStart(8, "0");
    if (!issued.includes(code)) return code;
  }
}

/** `ascii` with each ASCII digit moved to the digit block that starts at `zero`. */
const inDigits = (ascii: string, zero: number) => ascii.replace(/[0-9]/g, (d) => String.fromCharCode(zero + Number(d)));
/** Arabic-Indic digits, U+0660 to U+0669. */
const arabicIndic = (ascii: string) => inDigits(ascii, 0x0660);
/** Extended Arabic-Indic digits, U+06F0 to U+06F9. */
const extendedArabicIndic = (ascii: string) => inDigits(ascii, 0x06f0);
/** Fullwidth digits, U+FF10 to U+FF19: not digits a code or a phone may be typed in. */
const fullwidth = (ascii: string) => inDigits(ascii, 0xff10);

/* ─── Steps ────────────────────────────────────────────────────────────── */

/**
 * A test's steps, in order, each with what it gave and what the spec says it
 * gives; `verify` compares them all at once, so a failure shows the whole
 * sequence.
 */
function steps() {
  const actual: Record<string, unknown> = {};
  const expected: Record<string, unknown> = {};
  let n = 0;
  return {
    note(label: string, got: unknown, want: unknown) {
      const key = `${String(++n).padStart(2, "0")}. ${label}`;
      actual[key] = got;
      expected[key] = want;
    },
    verify() {
      expect(actual).toEqual(expected);
    },
  };
}

/* ─── Tests ────────────────────────────────────────────────────────────── */

describe("login codes: issue and check, through the two routes (#45)", () => {
  afterAll(async () => {
    if (template === undefined) return;
    const db = await template.catch(() => null);
    await db?.drop();
  }, 60_000);

  it(
    "L13: a requested code is logged once by the sender, stored only as the SHA-256 of the normalised identifier and the code, works once and not after expiry, and nothing else in the log holds a code or an identifier",
    () =>
      withCleanup(async (defer) => {
        // Done-when 1 over HTTP, and "only a hash is stored" (D4, F14).
        // On main the first POST /api/auth/code answers 404.
        const db = await fixtureDb(defer, "l13");
        const server = await startOn(db, defer);

        // A request by phone.
        const first = await requestCode(server, S1_PHONE, IP);
        expect(
          { ...told(first), "JSON content type": isJson(first) },
          `POST ${REQUEST_ROUTE} for ${S1_PHONE} (content-type: ${first.contentType})`,
        ).toEqual({ ...OK, "JSON content type": true });
        const C = await codeFor(server, S1_PHONE);
        expect(
          logLines(server).filter((line) => line === `[login-code] to=${S1_PHONE} code=${C}`),
          `log lines equal to "[login-code] to=${S1_PHONE} code=<C>"`,
        ).toHaveLength(1);

        const stored = await db.query(`SELECT code_hash FROM login_codes ORDER BY id`);
        expect(stored, "login_codes after the first request").toEqual([{ code_hash: hashOver(S1_PHONE, C) }]);
        const cells = await db.query(
          `SELECT 'login_codes' AS "table", to_jsonb(t) AS "values" FROM login_codes t
           UNION ALL SELECT 'login_events', to_jsonb(t) FROM login_events t`,
        );
        const holdingTheCode = cells.flatMap((r) =>
          Object.entries(r.values as Row)
            .filter(([, value]) => value !== null && String(value) === C)
            .map(([column]) => `${r.table}.${column}`),
        );
        expect(holdingTheCode, "columns of either table that equal the plain code").toEqual([]);

        const s = steps();
        s.note("check a different code", told(await checkCode(server, S1_PHONE, codeOtherThan([C]), IP)), refusal(401, "invalid_code"));
        s.note("check C", told(await checkCode(server, S1_PHONE, C, IP)), OK);
        s.note("check C again", told(await checkCode(server, S1_PHONE, C, IP)), refusal(401, "invalid_code"));

        // A request typed with spaces; its code, once expired, fails.
        s.note("request typed as +966 50 000 0002", told(await requestCode(server, "+966 50 000 0002", IP)), OK);
        s.verify();
        const D = await codeFor(server, S2_PHONE);
        await ageCodes(db, "10 minutes 1 second");
        expect(told(await checkCode(server, S2_PHONE, D, IP)), `check the aged code as ${S2_PHONE}`).toEqual(
          refusal(401, "invalid_code"),
        );

        // A request typed in mixed case: sent to, and hashed over, the stored form.
        expect(told(await requestCode(server, "S1@Clinic.Test", IP)), "request typed as S1@Clinic.Test").toEqual(OK);
        const E = await codeFor(server, S1_EMAIL);
        const newest = await db.query(`SELECT code_hash FROM login_codes ORDER BY id DESC LIMIT 1`);
        expect(newest, `the newest login_codes row, over ${S1_EMAIL} and E`).toEqual([{ code_hash: hashOver(S1_EMAIL, E) }]);
        expect(told(await checkCode(server, S1_EMAIL, E, IP)), `check E as ${S1_EMAIL}`).toEqual(OK);

        // Nothing but the sender's own lines holds a code or an identifier.
        await server.stop();
        const rest = logLines(server)
          .filter((line) => !line.startsWith(SENDER_PREFIX))
          .join("\n");
        const lowered = rest.toLowerCase();
        expect(
          {
            "codes in the log outside the sender's lines": [C, D, E].filter((code) => rest.includes(code)).length,
            "identifiers in the log outside the sender's lines": [S1_PHONE, S2_PHONE, S1_EMAIL].filter((identifier) =>
              lowered.includes(identifier.toLowerCase()),
            ),
          },
          `the log without its "${SENDER_PREFIX}" lines:\n${rest}`,
        ).toEqual({
          "codes in the log outside the sender's lines": 0,
          "identifiers in the log outside the sender's lines": [],
        });

        // Nor a stored hash (amendment 12): with 100,000,000 codes and a
        // known identifier, a hash in the log is the code.
        const hashes = await storedHashes(db);
        expect(hashes, "code_hash values in login_codes, to look for in the log").toHaveLength(3);
        expectNothingOutsideSenderLines(server, "L13", { hashes });
      }),
    ONE_SERVER_MS,
  );

  it(
    "L14: a known phone, an unknown phone, an account with no membership and an unknown email get the same status, body and content type at every step of four requests and six checks; only the known phone gets codes, and they differ",
    () =>
      withCleanup(async (defer) => {
        // Done-when 3 (D12): nothing in an answer depends on whether the
        // account exists. Each identifier has its own address, so only the
        // per-identifier caps are in play.
        // On main the first POST /api/auth/code answers 404.
        const db = await fixtureDb(defer, "l14");
        const server = await startOn(db, defer);
        const who = [
          { identifier: S1_PHONE, headers: realIp("198.51.100.1") },
          { identifier: UNKNOWN_PHONE, headers: realIp("198.51.100.2") },
          { identifier: S3_EMAIL, headers: realIp("198.51.100.3") },
          { identifier: UNKNOWN_EMAIL, headers: realIp("198.51.100.4") },
        ];
        /** One step for all four: each answer, against `want` with the known phone's content type. */
        const step = async (s: ReturnType<typeof steps>, label: string, call: (w: (typeof who)[number]) => Promise<Answer>, want: { status: number; body: string }) => {
          const answers: Answer[] = [];
          for (const w of who) answers.push(await call(w));
          s.note(
            label,
            Object.fromEntries(who.map((w, i) => [w.identifier, toldFully(answers[i])])),
            Object.fromEntries(who.map((w) => [w.identifier, { ...want, contentType: answers[0].contentType }])),
          );
          s.note(`${label}: the content type is JSON`, isJson(answers[0]), true);
        };

        const requests = steps();
        for (let n = 1; n <= 4; n++) {
          await step(
            requests,
            `request ${n} of 4`,
            (w) => requestCode(server, w.identifier, w.headers),
            n <= 3 ? OK : refusal(429, "too_many_requests"),
          );
        }
        requests.verify();

        // The known phone's three codes; the checks use a code that is none of them.
        await codeFor(server, S1_PHONE, 3);
        const issued = senderLines(server).map((line) => line.slice(line.lastIndexOf("code=") + 5));
        const wrong = codeOtherThan(issued);

        const checks = steps();
        for (let n = 1; n <= 6; n++) {
          await step(
            checks,
            `check ${n} of 6`,
            (w) => checkCode(server, w.identifier, wrong, w.headers),
            n <= 5 ? refusal(401, "invalid_code") : refusal(429, "too_many_attempts"),
          );
        }
        checks.verify();

        // Control: the known phone really was treated differently inside.
        await server.stop();
        const lines = senderLines(server);
        const codes = lines.map((line) => line.slice(line.lastIndexOf("code=") + 5));
        expect(
          {
            "login_codes rows per account": await db.query(
              `SELECT staff_id, count(*)::int AS rows FROM login_codes GROUP BY staff_id ORDER BY staff_id`,
            ),
            "[login-code] lines": lines.length,
            [`[login-code] lines to ${S1_PHONE}`]: lines.filter((line) => line.startsWith(`[login-code] to=${S1_PHONE} code=`)).length,
            "codes that match ^[0-9]{8}$": codes.filter((code) => /^[0-9]{8}$/.test(code)).length,
            "the three codes are all equal": new Set(codes).size === 1,
          },
          `sender lines: ${JSON.stringify(lines)}`,
        ).toEqual({
          "login_codes rows per account": [{ staff_id: "s1", rows: 3 }],
          "[login-code] lines": 3,
          [`[login-code] lines to ${S1_PHONE}`]: 3,
          "codes that match ^[0-9]{8}$": 3,
          "the three codes are all equal": false,
        });

        // The log rule on the 429 paths, and for accounts that don't exist
        // (amendment 11), and no stored hash (amendment 12).
        const hashes = await storedHashes(db);
        expect(hashes, "code_hash values in login_codes, to look for in the log").toHaveLength(3);
        expectNothingOutsideSenderLines(server, "L14", {
          codes,
          identifiers: [S1_PHONE, UNKNOWN_PHONE, S3_EMAIL, UNKNOWN_EMAIL],
          hashes,
        });
      }),
    ONE_SERVER_MS,
  );

  it(
    "L15: after five wrong codes the check route answers 429 too_many_attempts to the correct code, leaves it unused, still refuses at 14 minutes and accepts it at 15 minutes 1 second",
    () =>
      withCleanup(async (defer) => {
        // Done-when 2 over HTTP: the route maps the block, and the block is
        // 15 minutes.
        // On main the first POST /api/auth/code answers 404.
        const db = await fixtureDb(defer, "l15");
        const server = await startOn(db, defer);

        expect(told(await requestCode(server, S1_PHONE, IP)), `POST ${REQUEST_ROUTE} for ${S1_PHONE}`).toEqual(OK);
        const C = await codeFor(server, S1_PHONE);
        const wrong = codeOtherThan([C]);

        const s = steps();
        for (let n = 1; n <= 5; n++) {
          s.note(`wrong code ${n} of 5`, told(await checkCode(server, S1_PHONE, wrong, IP)), refusal(401, "invalid_code"));
        }
        s.note("check C", told(await checkCode(server, S1_PHONE, C, IP)), refusal(429, "too_many_attempts"));
        s.note(
          "the code row after the block",
          await db.query(`SELECT staff_id, used_at IS NULL AS unused FROM login_codes ORDER BY id`),
          [{ staff_id: "s1", unused: true }],
        );

        await ageEvents(db, "14 minutes");
        s.note("check C, 14 minutes on", told(await checkCode(server, S1_PHONE, C, IP)), refusal(429, "too_many_attempts"));

        await ageEvents(db, "1 minute 1 second");
        s.note("check C, 15 minutes 1 second on", told(await checkCode(server, S1_PHONE, C, IP)), OK);
        s.verify();

        // The log rule on the blocked path (amendment 11).
        await server.stop();
        expectNothingOutsideSenderLines(server, "L15", { codes: [C], identifiers: [S1_PHONE] });
      }),
    ONE_SERVER_MS,
  );

  it(
    "L16: the client address is X-Real-IP alone on both routes: X-Forwarded-For buys no new bucket and is no fallback, and a missing, empty, listed or malformed X-Real-IP is recorded as unknown",
    () =>
      withCleanup(async (defer) => {
        // D10, and amendment 1 for the check route.
        // On main the first POST /api/auth/code answers 404.
        const db = await fixtureDb(defer, "l16");
        const server = await startOn(db, defer);

        // (a) Twenty requests from one X-Real-IP, each under another
        // X-Forwarded-For, fill that address's bucket and no other.
        const a = steps();
        for (let i = 1; i <= 20; i++) {
          a.note(
            `(a) request ${i} of 20: X-Real-IP 198.51.100.7, X-Forwarded-For 203.0.113.${i}`,
            told(
              await requestCode(server, `ipa${i}@clinic.test`, {
                "X-Real-IP": "198.51.100.7",
                "X-Forwarded-For": `203.0.113.${i}`,
              }),
            ),
            OK,
          );
        }
        a.note(
          "(a) s1: X-Real-IP 198.51.100.7, X-Forwarded-For 203.0.113.99",
          told(await requestCode(server, S1_PHONE, { "X-Real-IP": "198.51.100.7", "X-Forwarded-For": "203.0.113.99" })),
          refusal(429, "too_many_requests"),
        );
        a.note(
          "(a) s1: X-Real-IP 198.51.100.8, X-Forwarded-For 203.0.113.99",
          told(await requestCode(server, S1_PHONE, { "X-Real-IP": "198.51.100.8", "X-Forwarded-For": "203.0.113.99" })),
          OK,
        );
        // The answers are judged before the table is read: on main there is
        // no route and no table, and the route is this test's reason.
        a.verify();
        expect(
          (await db.query(`SELECT DISTINCT ip FROM login_events ORDER BY ip`)).map((r) => r.ip),
          "(a) the distinct ip values in login_events",
        ).toEqual(["198.51.100.7", "198.51.100.8"]);

        // (b) One request each, for different identifiers.
        const b = steps();
        const cases: { label: string; headers: Record<string, string>; ip: string }[] = [
          { label: "(1) no X-Real-IP, X-Forwarded-For: 203.0.113.60", headers: { "X-Forwarded-For": "203.0.113.60" }, ip: "unknown" },
          { label: "(2) neither header", headers: {}, ip: "unknown" },
          { label: "(3) X-Real-IP: not-an-ip", headers: { "X-Real-IP": "not-an-ip" }, ip: "unknown" },
          { label: "(4) X-Real-IP empty", headers: { "X-Real-IP": "" }, ip: "unknown" },
          {
            label: "(5) X-Real-IP: 198.51.100.9, 203.0.113.50",
            headers: { "X-Real-IP": "198.51.100.9, 203.0.113.50" },
            ip: "unknown",
          },
          { label: "(6) X-Real-IP: 2001:DB8::1", headers: { "X-Real-IP": "2001:DB8::1" }, ip: "2001:db8::1" },
        ];
        for (const [i, c] of cases.entries()) {
          const identifier = `ipb${i + 1}@clinic.test`;
          b.note(`(b) ${c.label}`, told(await requestCode(server, identifier, c.headers)), OK);
          b.note(
            `(b) ${c.label}: the ip recorded`,
            (await db.query(`SELECT ip FROM login_events WHERE identifier = $1 ORDER BY id`, [identifier])).map((r) => r.ip),
            [c.ip],
          );
        }
        b.verify();

        // (c) The check route reads the address the same way.
        const c = steps();
        c.note(
          "(c) check for ipcheck1@clinic.test: X-Real-IP 198.51.100.21, X-Forwarded-For 203.0.113.77",
          told(
            await checkCode(server, "ipcheck1@clinic.test", "00000000", {
              "X-Real-IP": "198.51.100.21",
              "X-Forwarded-For": "203.0.113.77",
            }),
          ),
          refusal(401, "invalid_code"),
        );
        c.note(
          "(c) check for ipcheck2@clinic.test: no X-Real-IP, X-Forwarded-For 203.0.113.78",
          told(await checkCode(server, "ipcheck2@clinic.test", "00000000", { "X-Forwarded-For": "203.0.113.78" })),
          refusal(401, "invalid_code"),
        );
        c.note(
          "(c) the failure rows",
          await db.query(`SELECT identifier, ip FROM login_events WHERE kind = 'failure' ORDER BY id`),
          [
            { identifier: "ipcheck1@clinic.test", ip: "198.51.100.21" },
            { identifier: "ipcheck2@clinic.test", ip: "unknown" },
          ],
        );
        c.verify();
      }),
    ONE_SERVER_MS,
  );

  it(
    "L17: a body that is not a JSON object is 400 invalid_json, a missing or malformed field is its own 400, GET is 405, and none of it reaches the database or the sender",
    () =>
      withCleanup(async (defer) => {
        // Malformed input is answered from the text alone, in the routes'
        // usual shape.
        // On main the first POST /api/auth/code answers 404, and the GETs
        // answer 404, not 405.
        const db = await fixtureDb(defer, "l17");
        const server = await startOn(db, defer);
        const post = async (route: string, body: string) => told(await send(server.base, "POST", route, { headers: IP, body }));
        const s = steps();

        for (const body of ["this is not JSON", "null", "[]", '"x"', "5"]) {
          s.note(`request route, body ${body}`, await post(REQUEST_ROUTE, body), refusal(400, "invalid_json"));
        }
        for (const body of ["{}", '{"identifier":5}']) {
          s.note(`request route, body ${body}`, await post(REQUEST_ROUTE, body), refusal(400, "invalid_identifier"));
        }

        for (const body of ["this is not JSON", "null", "[]"]) {
          s.note(`check route, body ${body}`, await post(CHECK_ROUTE, body), refusal(400, "invalid_json"));
        }
        s.note(
          "check route, no code",
          await post(CHECK_ROUTE, JSON.stringify({ identifier: S1_PHONE })),
          refusal(400, "invalid_code_format"),
        );
        s.note(
          "check route, a malformed identifier with a valid code",
          await post(CHECK_ROUTE, JSON.stringify({ identifier: "0501234567", code: "12345678" })),
          refusal(400, "invalid_identifier"),
        );

        s.note(`GET ${REQUEST_ROUTE}`, (await send(server.base, "GET", REQUEST_ROUTE, { headers: IP })).status, 405);
        s.note(`GET ${CHECK_ROUTE}`, (await send(server.base, "GET", CHECK_ROUTE, { headers: IP })).status, 405);
        s.verify();

        await server.stop();
        expect({ rows: await tableCounts(db), "[login-code] lines": taggedLines(server) }).toEqual({
          rows: { login_codes: 0, login_events: 0 },
          "[login-code] lines": [],
        });

        // The log rule on the 400 paths (amendment 11): the malformed
        // identifier this test sends is not logged.
        expectNothingOutsideSenderLines(server, "L17", { identifiers: ["0501234567", S1_PHONE] });
      }),
    ONE_SERVER_MS,
  );

  it(
    "L18: a typed phone or email is brought to its stored form before it is recorded (separators, Arabic digits, invisible marks, letter case), and a form that can't be stored is 400 invalid_identifier with nothing recorded",
    () =>
      withCleanup(async (defer) => {
        // D15, over HTTP: one request per case, each from its own address,
        // so the one event row for that address shows what was recorded.
        // On main the first POST /api/auth/code answers 404.
        const db = await fixtureDb(defer, "l18");
        const server = await startOn(db, defer);

        const longEmail = (length: number) => `Long.${"a".repeat(length - "Long.".length - "@clinic.test".length)}@clinic.test`;
        const accepted: { label: string; typed: string; stored: string }[] = [
          { label: "+966500000011", typed: "+966500000011", stored: "+966500000011" },
          { label: "'  +966500000012  ' (spaces around)", typed: "  +966500000012  ", stored: "+966500000012" },
          { label: "+966 50 000 0013", typed: "+966 50 000 0013", stored: "+966500000013" },
          { label: "+966-50-000-0014", typed: "+966-50-000-0014", stored: "+966500000014" },
          { label: "+966 (50) 000 0015", typed: "+966 (50) 000 0015", stored: "+966500000015" },
          { label: "+966500000016 in Arabic-Indic digits", typed: `+${arabicIndic("966500000016")}`, stored: "+966500000016" },
          {
            label: "+966500000017 in Extended Arabic-Indic digits",
            typed: `+${extendedArabicIndic("966500000017")}`,
            stored: "+966500000017",
          },
          { label: "U+200F +966500000018 U+200E", typed: "\u200F+966500000018\u200E", stored: "+966500000018" },
          { label: "+966 50 000 0019 with U+00A0 for each space", typed: "+966\u00A050\u00A0000\u00A00019", stored: "+966500000019" },
          { label: "+12345678 (shortest)", typed: "+12345678", stored: "+12345678" },
          { label: "+123456789012345 (longest)", typed: "+123456789012345", stored: "+123456789012345" },
          { label: "Case.One@Clinic.Test", typed: "Case.One@Clinic.Test", stored: "case.one@clinic.test" },
          { label: "' trim.two@clinic.test ' (spaces around)", typed: " trim.two@clinic.test ", stored: "trim.two@clinic.test" },
          { label: "U+202B mark.three@clinic.test U+202C", typed: "\u202Bmark.three@clinic.test\u202C", stored: "mark.three@clinic.test" },
          { label: "a 254-character email", typed: longEmail(254), stored: longEmail(254).toLowerCase() },
        ];
        const refused: { label: string; typed: string }[] = [
          { label: "'' (empty)", typed: "" },
          { label: "'   ' (spaces only)", typed: "   " },
          { label: "0501234567 (local form)", typed: "0501234567" },
          { label: "966501234567 (no plus)", typed: "966501234567" },
          { label: "00966501234567", typed: "00966501234567" },
          { label: "+0501234567", typed: "+0501234567" },
          { label: "+9665012 (7 digits)", typed: "+9665012" },
          { label: "+9665012345678901 (16 digits)", typed: "+9665012345678901" },
          { label: "+966500000001x", typed: "+966500000001x" },
          { label: "++966500000001", typed: "++966500000001" },
          { label: "U+FF0B 966500000001 (fullwidth plus)", typed: "\uFF0B966500000001" },
          { label: "+966500000001 in fullwidth digits", typed: `+${fullwidth("966500000001")}` },
          { label: "s1clinic.test", typed: "s1clinic.test" },
          { label: "s1@clinic", typed: "s1@clinic" },
          { label: "a@b@clinic.test", typed: "a@b@clinic.test" },
          { label: "s 1@clinic.test", typed: "s 1@clinic.test" },
          { label: "سارة@clinic.test (Arabic letters)", typed: "سارة@clinic.test" },
          { label: "U+212A ate@clinic.test (Kelvin sign)", typed: "\u212Aate@clinic.test" },
          { label: "a 255-character email", typed: longEmail(255) },
        ];
        if (longEmail(254).length !== 254 || longEmail(255).length !== 255) {
          throw new Error("L18 setup: the long emails are not 254 and 255 characters");
        }

        const recordedFor = async (ip: string) =>
          (await db.query(`SELECT identifier FROM login_events WHERE ip = $1 ORDER BY id`, [ip])).map((r) => r.identifier);

        const acceptedIp = (i: number) => `198.51.100.${101 + i}`;
        const refusedIp = (i: number) => `203.0.113.${101 + i}`;

        // The answers first, and judged before the table is read: on main
        // there is no route and no table, and the route is this test's reason.
        const answers = steps();
        for (const [i, c] of accepted.entries()) {
          answers.note(`accepted: ${c.label}`, told(await requestCode(server, c.typed, realIp(acceptedIp(i)))), OK);
        }
        for (const [i, c] of refused.entries()) {
          answers.note(
            `refused: ${c.label}`,
            told(await requestCode(server, c.typed, realIp(refusedIp(i)))),
            refusal(400, "invalid_identifier"),
          );
        }
        answers.verify();

        // Then what each address left behind: the stored form, or nothing.
        const recorded = steps();
        for (const [i, c] of accepted.entries()) {
          recorded.note(`accepted: ${c.label}: recorded`, await recordedFor(acceptedIp(i)), [c.stored]);
        }
        for (const [i, c] of refused.entries()) {
          recorded.note(`refused: ${c.label}: recorded`, await recordedFor(refusedIp(i)), []);
        }
        recorded.verify();
      }),
    ONE_SERVER_MS,
  );

  it(
    "L19: a code typed in Arabic-Indic or Extended Arabic-Indic digits, with a space and an invisible mark, for an identifier sent as typed, is accepted; a code of any other shape is 400 invalid_code_format and is not counted as an attempt",
    () =>
      withCleanup(async (defer) => {
        // D16, and amendment 5: the two good checks send the identifier as a
        // person would type it, not in its stored form.
        // On main the first POST /api/auth/code answers 404.
        const db = await fixtureDb(defer, "l19");
        const server = await startOn(db, defer);

        expect(told(await requestCode(server, S1_PHONE, IP)), `POST ${REQUEST_ROUTE} for ${S1_PHONE}`).toEqual(OK);
        const C = await codeFor(server, S1_PHONE);
        const typedC = `\u200F${arabicIndic(C.slice(0, 4))} ${arabicIndic(C.slice(4))}`;
        expect(
          told(await checkCode(server, "+966 50 000 0001", typedC, IP)),
          "check as '+966 50 000 0001' with C in Arabic-Indic digits, a space in the middle and a leading U+200F",
        ).toEqual(OK);

        expect(told(await requestCode(server, S2_PHONE, IP)), `POST ${REQUEST_ROUTE} for ${S2_PHONE}`).toEqual(OK);
        const D = await codeFor(server, S2_PHONE);
        expect(
          told(await checkCode(server, `+${arabicIndic("966500000002")}`, extendedArabicIndic(D), IP)),
          "check as +966500000002 in Arabic-Indic digits with its code in Extended Arabic-Indic digits",
        ).toEqual(OK);

        const s = steps();
        const malformed: [string, unknown][] = [
          ["''", ""],
          ["'123456' (the v1 length)", "123456"],
          ["'1234567'", "1234567"],
          ["'123456789'", "123456789"],
          ["'1234567a'", "1234567a"],
          ["'12-34-56-78'", "12-34-56-78"],
          ["8 fullwidth digits", fullwidth("12345678")],
          ["the JSON number 12345678", 12345678],
          ["null", null],
        ];
        for (const [label, code] of malformed) {
          s.note(`s1: check with ${label}`, told(await checkCode(server, S1_PHONE, code, IP)), refusal(400, "invalid_code_format"));
        }
        s.note(
          "failure rows in login_events",
          (await db.query(`SELECT count(*)::int AS n FROM login_events WHERE kind = 'failure'`))[0].n,
          0,
        );
        s.verify();
      }),
    ONE_SERVER_MS,
  );

  it(
    "L20: under RAILWAY_ENVIRONMENT_NAME production, ' Production ' or prod the log sender refuses: 503 sender_unavailable for known and unknown alike, an [auth] line, nothing written; under staging or ' Staging ' it runs",
    () =>
      withCleanup(async (defer) => {
        // Done-when 4 (D13, D14): an allowlist, checked before a code is
        // generated or the database is touched. Five servers on one
        // database, one after another; the two controls come last.
        // On main the first POST /api/auth/code answers 404, not 503.
        const db = await fixtureDb(defer, "l20");

        const refusing = [
          { server: "A", name: "production", named: "production" },
          { server: "B", name: " Production ", named: "production" },
          { server: "D", name: "prod", named: "prod" },
        ];
        for (const r of refusing) {
          const tag = `server ${r.server} (RAILWAY_ENVIRONMENT_NAME=${JSON.stringify(r.name)})`;
          const server = await startOn(db, defer, r.name);
          const known = await requestCode(server, S1_PHONE, IP);
          const unknown = await requestCode(server, UNKNOWN_PHONE, IP);
          const malformed = await requestCode(server, "0501234567", IP);
          // Known and unknown: the same status, body and content type.
          const unavailable = { ...refusal(503, "sender_unavailable"), contentType: known.contentType };
          expect(
            {
              [`request for ${S1_PHONE}`]: toldFully(known),
              [`request for ${UNKNOWN_PHONE}`]: toldFully(unknown),
              "request for 0501234567": told(malformed),
            },
            tag,
          ).toEqual({
            [`request for ${S1_PHONE}`]: unavailable,
            [`request for ${UNKNOWN_PHONE}`]: unavailable,
            "request for 0501234567": refusal(400, "invalid_identifier"),
          });

          const line = `[auth] login code sender "log" refused: RAILWAY_ENVIRONMENT_NAME is "${r.named}" (allowed: empty or "staging")`;
          const logged = await logHasLine(server, line);
          await server.stop();
          expect(
            { [`the log has the line ${line}`]: logged, "[login-code] lines": taggedLines(server) },
            `${tag}, its log:\n${server.log()}`,
          ).toEqual({ [`the log has the line ${line}`]: true, "[login-code] lines": [] });

          // The log rule on the 503 and 400 paths (amendment 11).
          expectNothingOutsideSenderLines(server, tag, { identifiers: [S1_PHONE, UNKNOWN_PHONE, "0501234567"] });
        }
        expect(await tableCounts(db), "rows after servers A, B and D").toEqual({ login_codes: 0, login_events: 0 });

        // Controls: where the sender may run, the same request works.
        const running = [
          { server: "C", name: "staging", identifier: S1_PHONE },
          { server: "E", name: " Staging ", identifier: S2_PHONE },
        ];
        for (const r of running) {
          const tag = `server ${r.server} (RAILWAY_ENVIRONMENT_NAME=${JSON.stringify(r.name)})`;
          const before = (await tableCounts(db)).login_codes as number;
          const server = await startOn(db, defer, r.name);
          expect(told(await requestCode(server, r.identifier, IP)), `${tag}: request for ${r.identifier}`).toEqual(OK);
          await codeFor(server, r.identifier);
          await server.stop();
          expect(
            {
              "[login-code] lines": taggedLines(server).length,
              "new login_codes rows": ((await tableCounts(db)).login_codes as number) - before,
            },
            `${tag}, sender lines: ${JSON.stringify(taggedLines(server))}`,
          ).toEqual({ "[login-code] lines": 1, "new login_codes rows": 1 });
        }
      }),
    FIVE_SERVERS_MS,
  );
});
