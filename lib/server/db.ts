import "server-only";
import { Client, Pool, type ClientBase, type PoolClient } from "pg";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type {
  Appointment,
  ClinicalSession,
  InventoryItem,
  Invoice,
  Patient,
  SegmentInfo,
  SegmentStatus,
  SelectedExercise,
  SessionDraftPatch,
} from "@/lib/types";

/** Recordings live under this directory (gitignored); everything else is in Postgres. */
export const DATA_DIR =
  process.env.MADA_DATA_DIR || path.join(process.cwd(), "data");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");

export function uid(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "").slice(0, 12);
}

/** Unguessable handout token (URL-safe, 128 bits). */
export function newToken(): string {
  return randomBytes(16).toString("base64url");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Calendar date in the clinic's timezone (Asia/Riyadh), as YYYY-MM-DD. */
export function clinicToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/* ─── Connection and startup ──────────────────────────────────────────── */

/** `next start` runs from the repo root, so this is the repo's migrations/. */
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

/** Advisory-lock key that serialises startup across processes ("mada"). */
const STARTUP_LOCK = 0x6d616461;

/** A connection: the owner's startup client, or the pooled one a transaction runs on. */
type Queryable = ClientBase;

declare global {
  var __madaPool: Pool | undefined;
  var __madaReady: Promise<void> | undefined;
}

/**
 * The app's pool, as the app role (DATABASE_URL, `mada_app`), which row-level
 * security applies to (#10). One pool per process; survives dev HMR via
 * globalThis. Throws when DATABASE_URL is unset or empty: there is no
 * fallback store.
 */
function pool(): Pool {
  if (globalThis.__madaPool) return globalThis.__madaPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Mada keeps its data in Postgres and has no fallback.");
  }
  const p = new Pool({ connectionString });
  // An idle client can lose its connection (a database restart, a dropped
  // socket). Unhandled, that error crashes the process. The pool has already
  // discarded the client, so logging is all there is to do.
  p.on("error", (err) => console.error("[db] idle Postgres client failed:", err.message));
  globalThis.__madaPool = p;
  return p;
}

/**
 * The startup guard (#10, D3). Row-level security doesn't apply to a
 * superuser or a BYPASSRLS role, and a table's owner can turn it off, so a
 * DATABASE_URL that is any of those would silently serve every clinic's
 * rows. Refuse instead, naming the reason.
 */
async function guardAppRole(p: Pool): Promise<void> {
  const [r] = (
    await p.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean; owned: number }>(
      `SELECT r.rolname AS role, r.rolsuper, r.rolbypassrls,
         (SELECT COUNT(*)::int FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = r.oid) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
    )
  ).rows;
  const reasons: string[] = [];
  if (r.rolsuper) reasons.push("is a superuser");
  if (r.rolbypassrls) reasons.push("has BYPASSRLS");
  if (r.owned > 0) reasons.push(`owns ${r.owned} relation(s) in schema public`);
  if (reasons.length > 0) {
    throw new Error(
      `Refusing to serve: DATABASE_URL connects as role "${r.role}", which ${reasons.join(" and ")}, ` +
        `so row-level security would not apply. Point DATABASE_URL at the app role (mada_app) ` +
        `and DATABASE_OWNER_URL at the owner.`,
    );
  }
}

/** Applies every migrations/*.sql not yet in schema_migrations, in name order. */
async function migrate(client: Queryable): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations(
       name text PRIMARY KEY,
       "appliedAt" text NOT NULL
     )`,
  );
  const applied = new Set(
    (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
      (r) => r.name,
    ),
  );
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    await client.query(`INSERT INTO schema_migrations(name, "appliedAt") VALUES ($1, $2)`, [
      file,
      nowIso(),
    ]);
  }
}

/** The clinic the demo seed belongs to: 0002_clinics.sql's one row. */
const SEED_CLINIC_ID = "c1";

/** Runs in a c1 context: under FORCE, an owner that isn't a superuser sees only c1. */
async function seed(client: Queryable): Promise<void> {
  const count = (
    await client.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM patients")
  ).rows[0];
  if (count.n > 0) return;

  const today = clinicToday();
  const at = nowIso();
  // Demo data mirrors the prototype's seed — minus the hardcoded adherence
  // percentages, which now only ever come from real patient logs.
  const patients: Patient[] = [
    {
      id: "p1",
      name: "محمد عبدالله العتيبي",
      phone: "0551234567",
      fileNo: "1042",
      age: 38,
      sex: "ذكر",
      caseKey: "back",
      complaint: "ألم أسفل الظهر منذ شهر، يزداد مع الجلوس المطوّل.",
      status: "نشط",
      createdAt: at,
    },
    {
      id: "p2",
      name: "سارة أحمد الزهراني",
      phone: "0559876543",
      fileNo: "1043",
      age: 29,
      sex: "أنثى",
      caseKey: "neckstrain",
      complaint: "شدّ وتوتّر في الرقبة وأعلى الظهر.",
      status: "متابعة",
      createdAt: at,
    },
    {
      id: "p3",
      name: "فهد سعد القحطاني",
      phone: "0567778889",
      fileNo: "1044",
      age: 45,
      sex: "ذكر",
      caseKey: "knee",
      complaint: "ألم في الركبة بعد النشاط.",
      status: "نشط",
      createdAt: at,
    },
  ];
  const c = SEED_CLINIC_ID;
  for (const p of patients) await insertPatient(client, c, p);

  const insA = `INSERT INTO appointments(id,"patientId",date,time,type,status,clinic_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
  await client.query(insA, ["a1", "p1", today, "09:00", "متابعة", "محجوز", c]);
  await client.query(insA, ["a2", "p3", today, "10:30", "كشف", "محجوز", c]);
  await client.query(insA, ["a3", "p2", today, "12:00", "متابعة", "حضر", c]);

  await client.query(
    `INSERT INTO invoices(id,"patientId",date,items,total,paid,clinic_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ["i1", "p2", today, JSON.stringify([{ desc: "جلسة علاج طبيعي", amount: 300 }]), 300, 1, c],
  );

  const insN = "INSERT INTO inventory(id,name,qty,min,unit,clinic_id) VALUES ($1,$2,$3,$4,$5,$6)";
  await client.query(insN, ["n1", "أقطاب كهربائية (Electrodes)", 6, 10, "عبوة", c]);
  await client.query(insN, ["n2", "جل الموجات فوق الصوتية", 12, 5, "عبوة", c]);
  await client.query(insN, ["n3", "أشرطة مقاومة", 3, 8, "قطعة", c]);
  await client.query(insN, ["n4", "كمادات جل", 15, 6, "قطعة", c]);
}

/**
 * Creates the recordings directory and checks the app role (the guard runs
 * first, so a refused server writes nothing). Then migrates and seeds as the
 * owner (DATABASE_OWNER_URL), on one client of its own, in one transaction
 * that holds an advisory lock, so processes starting together take turns and
 * the seed lands once. That client is closed afterwards: requests never use
 * the owner.
 */
async function startup(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  await guardAppRole(pool());
  const ownerUrl = process.env.DATABASE_OWNER_URL;
  if (!ownerUrl) {
    throw new Error(
      "DATABASE_OWNER_URL is not set. Migrations run as the owner role; DATABASE_URL is the app role and can't run them.",
    );
  }
  const client = new Client({ connectionString: ownerUrl });
  client.on("error", (err) => console.error("[db] owner connection failed:", err.message));
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [STARTUP_LOCK]);
    await migrate(client);
    await client.query("SELECT set_config('app.clinic_id', $1, true)", [SEED_CLINIC_ID]);
    await seed(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Startup runs once per process: every query waits on this one promise. A
 * failed startup is forgotten, so the next request tries again, and fails
 * loudly again while the database is still unusable.
 */
function ready(): Promise<void> {
  if (!globalThis.__madaReady) {
    const started = startup();
    globalThis.__madaReady = started;
    started.catch(() => {
      if (globalThis.__madaReady === started) globalThis.__madaReady = undefined;
    });
  }
  return globalThis.__madaReady;
}

/**
 * Runs `fn` between BEGIN and COMMIT on one pooled client, once startup has
 * finished. On any error the transaction is rolled back, and the client
 * always goes back to the pool.
 */
async function transaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  await ready();
  const client = await pool().connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch((err: Error) => {
      broken = err;
    });
    throw e;
  } finally {
    // A client whose ROLLBACK failed is destroyed rather than reused.
    client.release(broken);
  }
}

/**
 * A transaction acting for one clinic (#10). set_config(…, true) is
 * `SET LOCAL` with a bind parameter (D8): it ends with the transaction, so
 * the pooled connection carries no clinic into the next request. Every query
 * on a clinic-scoped table runs inside one of these.
 */
function inClinic<T>(clinicId: string, fn: (db: PoolClient) => Promise<T>): Promise<T> {
  return transaction(async (db) => {
    await db.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    return fn(db);
  });
}

/** Rows of one query, as `clinicId`. */
function rows<R extends Row = Row>(clinicId: string, sql: string, params: unknown[] = []): Promise<R[]> {
  return inClinic(clinicId, async (db) => (await db.query<R>(sql, params)).rows);
}

/** Number of rows one write touched, as `clinicId`. */
function write(clinicId: string, sql: string, params: unknown[] = []): Promise<number> {
  return inClinic(clinicId, async (db) => (await db.query(sql, params)).rowCount ?? 0);
}

/** Rows of one query on `clinics`, which has no clinic_id and no RLS. */
async function clinicsRows<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
  await ready();
  return (await pool().query<R>(sql, params)).rows;
}

/* ─── Row mapping ─────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

function toPatient(r: Row): Patient {
  return {
    id: r.id as string,
    name: r.name as string,
    phone: r.phone as string,
    fileNo: r.fileNo as string,
    age: (r.age as number | null) ?? null,
    sex: r.sex as string,
    caseKey: r.caseKey as Patient["caseKey"],
    complaint: r.complaint as string,
    status: r.status as string,
    createdAt: r.createdAt as string,
  };
}

function toInvoice(r: Row): Invoice {
  let items: Invoice["items"] = [];
  try {
    const parsed = JSON.parse(r.items as string);
    if (Array.isArray(parsed)) items = parsed;
  } catch {
    /* keep [] — a corrupt row must not take the screen down */
  }
  return {
    id: r.id as string,
    patientId: r.patientId as string,
    date: r.date as string,
    items,
    total: r.total as number,
    paid: !!r.paid,
  };
}

function toSession(r: Row): ClinicalSession {
  let selected: Record<string, SelectedExercise> = {};
  try {
    const parsed = JSON.parse(r.selected as string);
    if (parsed && typeof parsed === "object") selected = parsed;
  } catch {
    /* keep {} */
  }
  let suggestedDx: string[] = [];
  try {
    const parsed = JSON.parse(r.suggestedDx as string);
    if (Array.isArray(parsed)) {
      suggestedDx = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* keep [] */
  }
  return {
    id: r.id as string,
    patientId: r.patientId as string,
    status: r.status as ClinicalSession["status"],
    therapistName: (r.therapistName as string | null) ?? "",
    step: r.step as number,
    dialogue: r.dialogue as string,
    assessment: r.assessment as string,
    dx: r.dx as string,
    date: r.date as string,
    sessionsCount: r.sessionsCount as string,
    frequency: r.frequency as string,
    home: r.home as string,
    follow: r.follow as string,
    pain: r.pain as string,
    advice: r.advice as string,
    planNotes: r.planNotes as string,
    selected,
    suggestedDx,
    report: r.report as string,
    sealed: !!r.sealed,
    sealDate: r.sealDate as string,
    handoutToken: r.handoutToken as string,
    consentAt: (r.consentAt as string | null) ?? null,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
    finishedAt: (r.finishedAt as string | null) ?? null,
  };
}

/* ─── Clinics ─────────────────────────────────────────────────────────── */
// Where the current clinic comes from is lib/server/clinic.ts's business.
// Creates take it as `clinicId`; the composite FKs keep a child in its
// parent's clinic (#9, 9a). Every read and update on a clinic-scoped table
// takes `clinicId` too and filters on it, so another clinic's id looks
// exactly like a missing one (#9, 9b).
//
// Since #10 every such query also runs in a transaction acting for that
// clinic (`rows`, `write`, `inClinic`), so row-level security hides the other
// clinics' rows even from a query that forgets its filter. The filters stay:
// RLS is the backstop, not a replacement. The handout page and the
// transcription worker have no request clinic; they take theirs from the
// token's session (`withHandout`) and from the queued job.

export async function clinicExists(id: string): Promise<boolean> {
  return (await clinicsRows("SELECT 1 FROM clinics WHERE id=$1", [id])).length > 0;
}

/** Every clinic, for the worker's recovery (D6). */
export async function listClinicIds(): Promise<string[]> {
  return (await clinicsRows<{ id: string }>(`SELECT id FROM clinics ORDER BY id COLLATE "C"`)).map((r) => r.id);
}

/* ─── Patients ────────────────────────────────────────────────────────── */
// Text sorts use COLLATE "C": byte order, as SQLite compared, whatever
// locale the database was created with.

export async function listPatients(clinicId: string): Promise<Patient[]> {
  return (
    await rows(
      clinicId,
      `SELECT * FROM patients WHERE clinic_id=$1 ORDER BY "createdAt" COLLATE "C" DESC, id COLLATE "C"`,
      [clinicId],
    )
  ).map(toPatient);
}

export async function getPatient(clinicId: string, id: string): Promise<Patient | null> {
  return inClinic(clinicId, (db) => patientOn(db, clinicId, id));
}

/** Shared with the handout path, which reads on its own transaction. */
async function patientOn(db: Queryable, clinicId: string, id: string): Promise<Patient | null> {
  const [r] = (await db.query("SELECT * FROM patients WHERE id=$1 AND clinic_id=$2", [id, clinicId])).rows;
  return r ? toPatient(r) : null;
}

export async function createPatient(
  clinicId: string,
  p: Omit<Patient, "id" | "createdAt">,
): Promise<Patient> {
  const patient: Patient = { ...p, id: uid("p"), createdAt: nowIso() };
  await inClinic(clinicId, (db) => insertPatient(db, clinicId, patient));
  return patient;
}

/** Shared with the seed, which runs on startup's own client. */
async function insertPatient(db: Queryable, clinicId: string, p: Patient): Promise<void> {
  await db.query(
    `INSERT INTO patients(id,name,phone,"fileNo",age,sex,"caseKey",complaint,status,"createdAt",clinic_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [p.id, p.name, p.phone, p.fileNo, p.age, p.sex, p.caseKey, p.complaint, p.status, p.createdAt, clinicId],
  );
}

/** Per clinic: each clinic numbers its patients from 1042 (D3). */
export async function nextFileNo(clinicId: string): Promise<string> {
  // ::int, or pg returns the bigint count as a string and this concatenates.
  const [{ n }] = await rows<{ n: number }>(
    clinicId,
    "SELECT COUNT(*)::int AS n FROM patients WHERE clinic_id=$1",
    [clinicId],
  );
  return String(1042 + n);
}

/* ─── Appointments ────────────────────────────────────────────────────── */

/** Named columns: the rows go to the API as they are, so clinic_id must stay out. */
const APPOINTMENT_COLUMNS = `id,"patientId",date,time,type,status`;

export async function listAppointments(clinicId: string, date?: string): Promise<Appointment[]> {
  const list = date
    ? await rows(
        clinicId,
        `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE clinic_id=$1 AND date=$2 ORDER BY time COLLATE "C"`,
        [clinicId, date],
      )
    : await rows(
        clinicId,
        `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE clinic_id=$1 ORDER BY date COLLATE "C" DESC, time COLLATE "C"`,
        [clinicId],
      );
  return list as Appointment[];
}

export async function createAppointment(
  clinicId: string,
  a: Omit<Appointment, "id" | "status">,
): Promise<Appointment> {
  const appt: Appointment = { ...a, id: uid("a"), status: "محجوز" };
  await write(
    clinicId,
    `INSERT INTO appointments(id,"patientId",date,time,type,status,clinic_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [appt.id, appt.patientId, appt.date, appt.time, appt.type, appt.status, clinicId],
  );
  return appt;
}

export async function setAppointmentStatus(
  clinicId: string,
  id: string,
  status: string,
): Promise<boolean> {
  return (
    (await write(clinicId, "UPDATE appointments SET status=$1 WHERE id=$2 AND clinic_id=$3", [
      status,
      id,
      clinicId,
    ])) > 0
  );
}

/* ─── Invoices ────────────────────────────────────────────────────────── */

export async function listInvoices(clinicId: string, patientId?: string): Promise<Invoice[]> {
  const list = patientId
    ? await rows(
        clinicId,
        `SELECT * FROM invoices WHERE clinic_id=$1 AND "patientId"=$2 ORDER BY date COLLATE "C" DESC, id COLLATE "C" DESC`,
        [clinicId, patientId],
      )
    : await rows(
        clinicId,
        `SELECT * FROM invoices WHERE clinic_id=$1 ORDER BY date COLLATE "C" DESC, id COLLATE "C" DESC`,
        [clinicId],
      );
  return list.map(toInvoice);
}

export async function createInvoice(
  clinicId: string,
  inv: Omit<Invoice, "id">,
): Promise<Invoice> {
  const invoice: Invoice = { ...inv, id: uid("i") };
  await write(
    clinicId,
    `INSERT INTO invoices(id,"patientId",date,items,total,paid,clinic_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      invoice.id,
      invoice.patientId,
      invoice.date,
      JSON.stringify(invoice.items),
      invoice.total,
      invoice.paid ? 1 : 0,
      clinicId,
    ],
  );
  return invoice;
}

export async function markInvoicePaid(clinicId: string, id: string): Promise<boolean> {
  return (await write(clinicId, "UPDATE invoices SET paid=1 WHERE id=$1 AND clinic_id=$2", [id, clinicId])) > 0;
}

/* ─── Inventory ───────────────────────────────────────────────────────── */

/** Insertion order, by `seq`; `seq` itself never leaves this function. */
export async function listInventory(clinicId: string): Promise<InventoryItem[]> {
  return rows<InventoryItem>(
    clinicId,
    "SELECT id,name,qty,min,unit FROM inventory WHERE clinic_id=$1 ORDER BY seq",
    [clinicId],
  );
}

export async function createInventoryItem(
  clinicId: string,
  item: Omit<InventoryItem, "id">,
): Promise<InventoryItem> {
  const it: InventoryItem = { ...item, id: uid("n") };
  await write(clinicId, "INSERT INTO inventory(id,name,qty,min,unit,clinic_id) VALUES ($1,$2,$3,$4,$5,$6)", [
    it.id,
    it.name,
    it.qty,
    it.min,
    it.unit,
    clinicId,
  ]);
  return it;
}

export async function adjustInventory(
  clinicId: string,
  id: string,
  delta: number,
): Promise<boolean> {
  return (
    (await write(
      clinicId,
      "UPDATE inventory SET qty=GREATEST(0, qty + $1) WHERE id=$2 AND clinic_id=$3",
      [delta, id, clinicId],
    )) > 0
  );
}

/* ─── Sessions ────────────────────────────────────────────────────────── */

export async function listSessions(
  clinicId: string,
  patientId?: string,
): Promise<ClinicalSession[]> {
  const list = patientId
    ? await rows(
        clinicId,
        `SELECT * FROM sessions WHERE clinic_id=$1 AND "patientId"=$2 ORDER BY "createdAt" COLLATE "C" DESC`,
        [clinicId, patientId],
      )
    : await rows(clinicId, `SELECT * FROM sessions ORDER BY "createdAt" COLLATE "C" DESC`);
  return list.map(toSession);
}

export async function getSession(clinicId: string, id: string): Promise<ClinicalSession | null> {
  const [r] = await rows(clinicId, "SELECT * FROM sessions WHERE id=$1 AND clinic_id=$2", [id, clinicId]);
  return r ? toSession(r) : null;
}

/** The handout page's view of the database: one session, in that session's clinic. */
export type Handout = {
  session: ClinicalSession;
  patient: () => Promise<Patient | null>;
  adherence: () => Promise<AdherenceLog[]>;
  painLogs: () => Promise<PainLog[]>;
  setAdherence: (day: string, exIdx: number, done: boolean) => Promise<void>;
  setPainLog: (day: string, pain: number) => Promise<void>;
};

/**
 * The handout-token path (D5). The token is the credential, and the handout
 * page has no clinic of its own. One transaction sets `app.handout_token`,
 * which the token policy on `sessions` lets read that one session, then sets
 * `app.clinic_id` to the session's clinic, and runs `fn` on that transaction.
 * Both settings end with it. Null, without calling `fn`, when no session has
 * this token.
 */
export async function withHandout<T>(token: string, fn: (h: Handout) => Promise<T>): Promise<T | null> {
  return transaction(async (db) => {
    await db.query("SELECT set_config('app.handout_token', $1, false)", [token]);
    const [r] = (await db.query(`SELECT * FROM sessions WHERE "handoutToken"=$1`, [token])).rows;
    if (!r) return null;
    const clinicId = r.clinic_id as string;
    await db.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const session = toSession(r);
    return fn({
      session,
      patient: () => patientOn(db, clinicId, session.patientId),
      adherence: () => adherenceOn(db, clinicId, session.id),
      painLogs: () => painLogsOn(db, clinicId, session.id),
      setAdherence: (day, exIdx, done) => setAdherenceOn(db, clinicId, session.id, day, exIdx, done),
      setPainLog: (day, pain) => setPainLogOn(db, clinicId, session.id, day, pain),
    });
  });
}

/** `therapistName` is stamped once here and never patched afterwards. */
export async function createSession(
  clinicId: string,
  patientId: string,
  therapistName = "",
): Promise<ClinicalSession> {
  const at = nowIso();
  const session: ClinicalSession = {
    id: uid("s"),
    patientId,
    status: "draft",
    therapistName,
    step: 0,
    dialogue: "",
    assessment: "",
    dx: "",
    date: clinicToday(),
    sessionsCount: "",
    frequency: "",
    home: "",
    follow: "",
    pain: "",
    advice: "",
    planNotes: "",
    selected: {},
    suggestedDx: [],
    report: "",
    sealed: false,
    sealDate: "",
    handoutToken: newToken(),
    consentAt: null,
    createdAt: at,
    updatedAt: at,
    finishedAt: null,
  };
  await write(
    clinicId,
    `INSERT INTO sessions(id,"patientId",status,"therapistName",step,dialogue,assessment,dx,date,"sessionsCount",frequency,home,follow,pain,advice,"planNotes",selected,"suggestedDx",report,sealed,"sealDate","handoutToken","consentAt","createdAt","updatedAt","finishedAt",clinic_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
    [
      session.id,
      session.patientId,
      session.status,
      session.therapistName,
      session.step,
      session.dialogue,
      session.assessment,
      session.dx,
      session.date,
      session.sessionsCount,
      session.frequency,
      session.home,
      session.follow,
      session.pain,
      session.advice,
      session.planNotes,
      JSON.stringify(session.selected),
      JSON.stringify(session.suggestedDx),
      session.report,
      session.sealed ? 1 : 0,
      session.sealDate,
      session.handoutToken,
      session.consentAt,
      session.createdAt,
      session.updatedAt,
      session.finishedAt,
      clinicId,
    ],
  );
  return session;
}

const DRAFT_FIELDS = [
  "step",
  "dialogue",
  "assessment",
  "dx",
  "date",
  "sessionsCount",
  "frequency",
  "home",
  "follow",
  "pain",
  "advice",
  "planNotes",
  "selected",
  "suggestedDx",
  "report",
  "sealed",
  "sealDate",
] as const;

/** Autosave: applies only whitelisted fields; returns the fresh row. */
export async function patchSession(
  clinicId: string,
  id: string,
  patch: SessionDraftPatch,
): Promise<ClinicalSession | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const f of DRAFT_FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (f === "selected") params.push(JSON.stringify(v ?? {}));
    else if (f === "suggestedDx") params.push(JSON.stringify(v ?? []));
    else if (f === "sealed") params.push(v ? 1 : 0);
    else params.push(v);
    // `f` comes from DRAFT_FIELDS, never from the request; quoted for camelCase.
    sets.push(`"${f}"=$${params.length}`);
  }
  if (sets.length) {
    params.push(nowIso(), id, clinicId);
    const n = params.length;
    await write(
      clinicId,
      `UPDATE sessions SET ${sets.join(",")}, "updatedAt"=$${n - 2} WHERE id=$${n - 1} AND clinic_id=$${n} AND status='draft'`,
      params,
    );
  }
  return getSession(clinicId, id);
}

export async function setSessionConsent(
  clinicId: string,
  id: string,
): Promise<ClinicalSession | null> {
  await write(
    clinicId,
    `UPDATE sessions SET "consentAt"=$1, "updatedAt"=$2 WHERE id=$3 AND clinic_id=$4 AND "consentAt" IS NULL`,
    [nowIso(), nowIso(), id, clinicId],
  );
  return getSession(clinicId, id);
}

/**
 * Finish: marks final and creates the session invoice, atomically, in one
 * transaction acting for the clinic.
 */
export async function finishSession(
  clinicId: string,
  id: string,
): Promise<ClinicalSession | null> {
  await inClinic(clinicId, async (client) => {
    const at = nowIso();
    const res = await client.query(
      `UPDATE sessions SET status='final', "finishedAt"=$1, "updatedAt"=$2 WHERE id=$3 AND clinic_id=$4 AND status='draft'`,
      [at, at, id, clinicId],
    );
    if ((res.rowCount ?? 0) > 0) {
      // Same behaviour as the prototype: an unpaid invoice per finished
      // session. Patient and clinic come from the session row.
      await client.query(
        `INSERT INTO invoices(id,"patientId",date,items,total,paid,clinic_id)
         SELECT $1::text, "patientId", $2::text, $3::text, $4::double precision, 0, clinic_id
         FROM sessions WHERE id=$5 AND clinic_id=$6`,
        [uid("i"), clinicToday(), JSON.stringify([{ desc: "جلسة علاج طبيعي", amount: 300 }]), 300, id, clinicId],
      );
    }
  });
  return getSession(clinicId, id);
}

/* ─── Recordings & segments ───────────────────────────────────────────── */

export async function createRecording(
  clinicId: string,
  sessionId: string,
  mime: string,
): Promise<string> {
  const id = uid("r");
  await write(
    clinicId,
    `INSERT INTO recordings(id,"sessionId",mime,"startedAt",clinic_id) VALUES ($1,$2,$3,$4,$5)`,
    [id, sessionId, mime, nowIso(), clinicId],
  );
  fs.mkdirSync(path.join(RECORDINGS_DIR, id), { recursive: true });
  return id;
}

type RecordingRow = { id: string; sessionId: string; mime: string; startedAt: string };

/** Named columns, so clinic_id stays out of the row. */
const RECORDING_COLUMNS = `id,"sessionId",mime,"startedAt"`;

export async function getRecording(clinicId: string, id: string): Promise<RecordingRow | null> {
  const [r] = await rows<RecordingRow>(
    clinicId,
    `SELECT ${RECORDING_COLUMNS} FROM recordings WHERE id=$1 AND clinic_id=$2`,
    [id, clinicId],
  );
  return r ?? null;
}

export function segmentPath(recordingId: string, seq: number, ext: string): string {
  return path.join(RECORDINGS_DIR, recordingId, `${seq}.${ext}`);
}

/**
 * `preferred` is the device's transcription choice at upload time, stored
 * opaquely (the transcribe module interprets it) so a switch mid-recording
 * applies from the next segment on.
 */
export async function upsertSegment(
  clinicId: string,
  recordingId: string,
  seq: number,
  bytes: number,
  preferred = "",
): Promise<void> {
  const at = nowIso();
  await write(
    clinicId,
    `INSERT INTO segments("recordingId",seq,status,text,error,bytes,preferred,"createdAt","updatedAt",clinic_id)
     VALUES ($1,$2,'uploaded','','',$3,$4,$5,$6,$7)
     ON CONFLICT("recordingId",seq) DO UPDATE SET status='uploaded', error='', bytes=excluded.bytes, preferred=excluded.preferred, "updatedAt"=excluded."updatedAt"
     WHERE segments.clinic_id=excluded.clinic_id`,
    [recordingId, seq, bytes, preferred, at, at, clinicId],
  );
}

/**
 * The transcription worker's clinic is the job's; the retry route passes the
 * request's.
 */
export async function setSegmentStatus(
  clinicId: string,
  recordingId: string,
  seq: number,
  status: SegmentStatus,
  fields: { text?: string; error?: string; provider?: string; note?: string; preferred?: string } = {},
): Promise<void> {
  await write(
    clinicId,
    `UPDATE segments SET status=$1, text=COALESCE($2, text), error=COALESCE($3, error),
       provider=COALESCE($4, provider), note=COALESCE($5, note), preferred=COALESCE($6, preferred), "updatedAt"=$7
     WHERE "recordingId"=$8 AND seq=$9 AND clinic_id=$10`,
    [
      status,
      fields.text ?? null,
      fields.error ?? null,
      fields.provider ?? null,
      fields.note ?? null,
      fields.preferred ?? null,
      nowIso(),
      recordingId,
      seq,
      clinicId,
    ],
  );
}

/** The transcription worker's, as the job's clinic. */
export async function segmentPreference(clinicId: string, recordingId: string, seq: number): Promise<string> {
  const [row] = await rows<{ preferred: string }>(
    clinicId,
    `SELECT preferred FROM segments WHERE "recordingId"=$1 AND seq=$2 AND clinic_id=$3`,
    [recordingId, seq, clinicId],
  );
  return row?.preferred ?? "";
}

export async function listSegments(clinicId: string, recordingId: string): Promise<SegmentInfo[]> {
  return rows<SegmentInfo>(
    clinicId,
    `SELECT seq,status,text,error,provider,note FROM segments WHERE "recordingId"=$1 AND clinic_id=$2 ORDER BY seq`,
    [recordingId, clinicId],
  );
}

export async function getSegment(
  clinicId: string,
  recordingId: string,
  seq: number,
): Promise<SegmentInfo | null> {
  const [r] = await rows<SegmentInfo>(
    clinicId,
    `SELECT seq,status,text,error,provider,note FROM segments WHERE "recordingId"=$1 AND seq=$2 AND clinic_id=$3`,
    [recordingId, seq, clinicId],
  );
  return r ?? null;
}

/**
 * Tail of the transcript before `seq` — context prompt for continuity.
 * The transcription worker's, as the job's clinic.
 */
export async function transcriptTailBefore(clinicId: string, recordingId: string, seq: number): Promise<string> {
  const list = await rows<{ text: string }>(
    clinicId,
    `SELECT text FROM segments WHERE "recordingId"=$1 AND seq<$2 AND status='done' AND clinic_id=$3 ORDER BY seq`,
    [recordingId, seq, clinicId],
  );
  return list
    .map((r) => r.text)
    .join(" ")
    .slice(-300);
}

/**
 * One clinic's segments left `uploaded` or `transcribing` when the server
 * last stopped. The worker's recovery asks once per clinic (D6).
 */
export async function listPendingSegments(clinicId: string): Promise<{ recordingId: string; seq: number }[]> {
  return rows<{ recordingId: string; seq: number }>(
    clinicId,
    `SELECT "recordingId", seq FROM segments WHERE status IN ('uploaded','transcribing') AND clinic_id=$1
     ORDER BY "recordingId" COLLATE "C", seq`,
    [clinicId],
  );
}

/* ─── Adherence (patient-logged) ──────────────────────────────────────── */
// The handout page writes these through `withHandout`, in the token's
// session's clinic. The clinic screens read them through
// lib/server/adherence.ts, in the request's.

export type AdherenceLog = { day: string; exIdx: number; done: boolean };
export type PainLog = { day: string; pain: number; updatedAt: string };

async function setAdherenceOn(
  db: Queryable,
  clinicId: string,
  sessionId: string,
  day: string,
  exIdx: number,
  done: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO adherence("sessionId",day,"exIdx",done,"updatedAt",clinic_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT("sessionId",day,"exIdx") DO UPDATE SET done=excluded.done, "updatedAt"=excluded."updatedAt"`,
    [sessionId, day, exIdx, done ? 1 : 0, nowIso(), clinicId],
  );
}

async function setPainLogOn(
  db: Queryable,
  clinicId: string,
  sessionId: string,
  day: string,
  pain: number,
): Promise<void> {
  await db.query(
    `INSERT INTO pain_logs("sessionId",day,pain,"updatedAt",clinic_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT("sessionId",day) DO UPDATE SET pain=excluded.pain, "updatedAt"=excluded."updatedAt"`,
    [sessionId, day, pain, nowIso(), clinicId],
  );
}

async function adherenceOn(db: Queryable, clinicId: string, sessionId: string): Promise<AdherenceLog[]> {
  return (
    await db.query<{ day: string; exIdx: number; done: number }>(
      `SELECT day,"exIdx",done FROM adherence WHERE "sessionId"=$1 AND clinic_id=$2 ORDER BY day COLLATE "C","exIdx"`,
      [sessionId, clinicId],
    )
  ).rows.map((r) => ({ day: r.day, exIdx: r.exIdx, done: !!r.done }));
}

async function painLogsOn(db: Queryable, clinicId: string, sessionId: string): Promise<PainLog[]> {
  return (
    await db.query<PainLog>(
      `SELECT day,pain,"updatedAt" FROM pain_logs WHERE "sessionId"=$1 AND clinic_id=$2 ORDER BY day COLLATE "C"`,
      [sessionId, clinicId],
    )
  ).rows;
}

export function listAdherence(clinicId: string, sessionId: string): Promise<AdherenceLog[]> {
  return inClinic(clinicId, (db) => adherenceOn(db, clinicId, sessionId));
}

export function listPainLogs(clinicId: string, sessionId: string): Promise<PainLog[]> {
  return inClinic(clinicId, (db) => painLogsOn(db, clinicId, sessionId));
}

/** Latest adherence or pain log for a session (ISO text), or null when none. */
export async function lastLogAt(clinicId: string, sessionId: string): Promise<string | null> {
  const [{ t }] = await rows<{ t: string | null }>(
    clinicId,
    `SELECT MAX(t COLLATE "C") AS t FROM (
       SELECT MAX("updatedAt" COLLATE "C") AS t FROM adherence WHERE "sessionId"=$1 AND clinic_id=$2
       UNION ALL
       SELECT MAX("updatedAt" COLLATE "C") AS t FROM pain_logs WHERE "sessionId"=$1 AND clinic_id=$2
     ) AS logs`,
    [sessionId, clinicId],
  );
  return t ?? null;
}
