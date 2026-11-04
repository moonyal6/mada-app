import "server-only";
import { Pool, type PoolClient } from "pg";
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

/** The pool, or the one client a transaction runs on. */
type Queryable = Pool | PoolClient;

declare global {
  var __madaPool: Pool | undefined;
  var __madaReady: Promise<void> | undefined;
}

/**
 * One pool per process; survives dev HMR via globalThis. Throws when
 * DATABASE_URL is unset or empty: there is no fallback store.
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

/** Applies every migrations/*.sql not yet in schema_migrations, in name order. */
async function migrate(client: PoolClient): Promise<void> {
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

async function seed(client: PoolClient): Promise<void> {
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
  for (const p of patients) await insertPatient(client, p);

  const insA = `INSERT INTO appointments(id,"patientId",date,time,type,status) VALUES ($1,$2,$3,$4,$5,$6)`;
  await client.query(insA, ["a1", "p1", today, "09:00", "متابعة", "محجوز"]);
  await client.query(insA, ["a2", "p3", today, "10:30", "كشف", "محجوز"]);
  await client.query(insA, ["a3", "p2", today, "12:00", "متابعة", "حضر"]);

  await client.query(
    `INSERT INTO invoices(id,"patientId",date,items,total,paid) VALUES ($1,$2,$3,$4,$5,$6)`,
    ["i1", "p2", today, JSON.stringify([{ desc: "جلسة علاج طبيعي", amount: 300 }]), 300, 1],
  );

  const insN = "INSERT INTO inventory(id,name,qty,min,unit) VALUES ($1,$2,$3,$4,$5)";
  await client.query(insN, ["n1", "أقطاب كهربائية (Electrodes)", 6, 10, "عبوة"]);
  await client.query(insN, ["n2", "جل الموجات فوق الصوتية", 12, 5, "عبوة"]);
  await client.query(insN, ["n3", "أشرطة مقاومة", 3, 8, "قطعة"]);
  await client.query(insN, ["n4", "كمادات جل", 15, 6, "قطعة"]);
}

/**
 * Creates the recordings directory, then migrates and seeds in one
 * transaction that holds an advisory lock, so processes starting together
 * take turns and the seed lands once.
 */
async function startup(): Promise<void> {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const client = await pool().connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [STARTUP_LOCK]);
    await migrate(client);
    await seed(client);
    await client.query("COMMIT");
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

/** Rows of one query on the pool, once startup has finished. */
async function rows<R extends Row = Row>(sql: string, params: unknown[] = []): Promise<R[]> {
  await ready();
  return (await pool().query<R>(sql, params)).rows;
}

/** Number of rows a write touched, once startup has finished. */
async function write(sql: string, params: unknown[] = []): Promise<number> {
  await ready();
  return (await pool().query(sql, params)).rowCount ?? 0;
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

/* ─── Patients ────────────────────────────────────────────────────────── */
// Text sorts use COLLATE "C": byte order, as SQLite compared, whatever
// locale the database was created with.

export async function listPatients(): Promise<Patient[]> {
  return (
    await rows(`SELECT * FROM patients ORDER BY "createdAt" COLLATE "C" DESC, id COLLATE "C"`)
  ).map(toPatient);
}

export async function getPatient(id: string): Promise<Patient | null> {
  const [r] = await rows("SELECT * FROM patients WHERE id=$1", [id]);
  return r ? toPatient(r) : null;
}

export async function createPatient(
  p: Omit<Patient, "id" | "createdAt">,
): Promise<Patient> {
  const patient: Patient = { ...p, id: uid("p"), createdAt: nowIso() };
  await ready();
  await insertPatient(pool(), patient);
  return patient;
}

/** Shared with the seed, which runs on startup's own client. */
async function insertPatient(db: Queryable, p: Patient): Promise<void> {
  await db.query(
    `INSERT INTO patients(id,name,phone,"fileNo",age,sex,"caseKey",complaint,status,"createdAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [p.id, p.name, p.phone, p.fileNo, p.age, p.sex, p.caseKey, p.complaint, p.status, p.createdAt],
  );
}

export async function nextFileNo(): Promise<string> {
  // ::int, or pg returns the bigint count as a string and this concatenates.
  const [{ n }] = await rows<{ n: number }>("SELECT COUNT(*)::int AS n FROM patients");
  return String(1042 + n);
}

/* ─── Appointments ────────────────────────────────────────────────────── */

export async function listAppointments(date?: string): Promise<Appointment[]> {
  const list = date
    ? await rows(`SELECT * FROM appointments WHERE date=$1 ORDER BY time COLLATE "C"`, [date])
    : await rows(`SELECT * FROM appointments ORDER BY date COLLATE "C" DESC, time COLLATE "C"`);
  return list as Appointment[];
}

export async function createAppointment(
  a: Omit<Appointment, "id" | "status">,
): Promise<Appointment> {
  const appt: Appointment = { ...a, id: uid("a"), status: "محجوز" };
  await write(
    `INSERT INTO appointments(id,"patientId",date,time,type,status) VALUES ($1,$2,$3,$4,$5,$6)`,
    [appt.id, appt.patientId, appt.date, appt.time, appt.type, appt.status],
  );
  return appt;
}

export async function setAppointmentStatus(id: string, status: string): Promise<boolean> {
  return (await write("UPDATE appointments SET status=$1 WHERE id=$2", [status, id])) > 0;
}

/* ─── Invoices ────────────────────────────────────────────────────────── */

export async function listInvoices(patientId?: string): Promise<Invoice[]> {
  const list = patientId
    ? await rows(
        `SELECT * FROM invoices WHERE "patientId"=$1 ORDER BY date COLLATE "C" DESC, id COLLATE "C" DESC`,
        [patientId],
      )
    : await rows(`SELECT * FROM invoices ORDER BY date COLLATE "C" DESC, id COLLATE "C" DESC`);
  return list.map(toInvoice);
}

export async function createInvoice(inv: Omit<Invoice, "id">): Promise<Invoice> {
  await ready();
  return insertInvoice(pool(), inv);
}

/** Takes the client so `finishSession` can run it inside its transaction. */
async function insertInvoice(db: Queryable, inv: Omit<Invoice, "id">): Promise<Invoice> {
  const invoice: Invoice = { ...inv, id: uid("i") };
  await db.query(
    `INSERT INTO invoices(id,"patientId",date,items,total,paid) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      invoice.id,
      invoice.patientId,
      invoice.date,
      JSON.stringify(invoice.items),
      invoice.total,
      invoice.paid ? 1 : 0,
    ],
  );
  return invoice;
}

export async function markInvoicePaid(id: string): Promise<boolean> {
  return (await write("UPDATE invoices SET paid=1 WHERE id=$1", [id])) > 0;
}

/* ─── Inventory ───────────────────────────────────────────────────────── */

/** Insertion order, by `seq`; `seq` itself never leaves this function. */
export async function listInventory(): Promise<InventoryItem[]> {
  return rows<InventoryItem>("SELECT id,name,qty,min,unit FROM inventory ORDER BY seq");
}

export async function createInventoryItem(
  item: Omit<InventoryItem, "id">,
): Promise<InventoryItem> {
  const it: InventoryItem = { ...item, id: uid("n") };
  await write("INSERT INTO inventory(id,name,qty,min,unit) VALUES ($1,$2,$3,$4,$5)", [
    it.id,
    it.name,
    it.qty,
    it.min,
    it.unit,
  ]);
  return it;
}

export async function adjustInventory(id: string, delta: number): Promise<boolean> {
  return (
    (await write("UPDATE inventory SET qty=GREATEST(0, qty + $1) WHERE id=$2", [delta, id])) > 0
  );
}

/* ─── Sessions ────────────────────────────────────────────────────────── */

export async function listSessions(patientId?: string): Promise<ClinicalSession[]> {
  const list = patientId
    ? await rows(
        `SELECT * FROM sessions WHERE "patientId"=$1 ORDER BY "createdAt" COLLATE "C" DESC`,
        [patientId],
      )
    : await rows(`SELECT * FROM sessions ORDER BY "createdAt" COLLATE "C" DESC`);
  return list.map(toSession);
}

export async function getSession(id: string): Promise<ClinicalSession | null> {
  await ready();
  return readSession(pool(), id);
}

/** Takes the client so `finishSession` can run it inside its transaction. */
async function readSession(db: Queryable, id: string): Promise<ClinicalSession | null> {
  const [r] = (await db.query<Row>("SELECT * FROM sessions WHERE id=$1", [id])).rows;
  return r ? toSession(r) : null;
}

export async function getSessionByToken(token: string): Promise<ClinicalSession | null> {
  const [r] = await rows(`SELECT * FROM sessions WHERE "handoutToken"=$1`, [token]);
  return r ? toSession(r) : null;
}

/** `therapistName` is stamped once here and never patched afterwards. */
export async function createSession(
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
    `INSERT INTO sessions(id,"patientId",status,"therapistName",step,dialogue,assessment,dx,date,"sessionsCount",frequency,home,follow,pain,advice,"planNotes",selected,"suggestedDx",report,sealed,"sealDate","handoutToken","consentAt","createdAt","updatedAt","finishedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
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
    params.push(nowIso(), id);
    const n = params.length;
    await write(
      `UPDATE sessions SET ${sets.join(",")}, "updatedAt"=$${n - 1} WHERE id=$${n} AND status='draft'`,
      params,
    );
  }
  return getSession(id);
}

export async function setSessionConsent(id: string): Promise<ClinicalSession | null> {
  await write(
    `UPDATE sessions SET "consentAt"=$1, "updatedAt"=$2 WHERE id=$3 AND "consentAt" IS NULL`,
    [nowIso(), nowIso(), id],
  );
  return getSession(id);
}

/**
 * Finish: marks final and creates the session invoice, atomically. Every
 * statement runs on one client between BEGIN and COMMIT; on any error the
 * transaction is rolled back, and the client always goes back to the pool.
 */
export async function finishSession(id: string): Promise<ClinicalSession | null> {
  await ready();
  const client = await pool().connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const at = nowIso();
    const res = await client.query(
      `UPDATE sessions SET status='final', "finishedAt"=$1, "updatedAt"=$2 WHERE id=$3 AND status='draft'`,
      [at, at, id],
    );
    if ((res.rowCount ?? 0) > 0) {
      // Same behaviour as the prototype: an unpaid invoice per finished session.
      const session = (await readSession(client, id))!;
      await insertInvoice(client, {
        patientId: session.patientId,
        date: clinicToday(),
        items: [{ desc: "جلسة علاج طبيعي", amount: 300 }],
        total: 300,
        paid: false,
      });
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch((err: Error) => {
      broken = err;
    });
    throw e;
  }
  return getSession(id);
}

/* ─── Recordings & segments ───────────────────────────────────────────── */

export async function createRecording(sessionId: string, mime: string): Promise<string> {
  const id = uid("r");
  await write(
    `INSERT INTO recordings(id,"sessionId",mime,"startedAt") VALUES ($1,$2,$3,$4)`,
    [id, sessionId, mime, nowIso()],
  );
  fs.mkdirSync(path.join(RECORDINGS_DIR, id), { recursive: true });
  return id;
}

export async function getRecording(
  id: string,
): Promise<{ id: string; sessionId: string; mime: string; startedAt: string } | null> {
  const [r] = await rows<{ id: string; sessionId: string; mime: string; startedAt: string }>(
    "SELECT * FROM recordings WHERE id=$1",
    [id],
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
  recordingId: string,
  seq: number,
  bytes: number,
  preferred = "",
): Promise<void> {
  const at = nowIso();
  await write(
    `INSERT INTO segments("recordingId",seq,status,text,error,bytes,preferred,"createdAt","updatedAt")
     VALUES ($1,$2,'uploaded','','',$3,$4,$5,$6)
     ON CONFLICT("recordingId",seq) DO UPDATE SET status='uploaded', error='', bytes=excluded.bytes, preferred=excluded.preferred, "updatedAt"=excluded."updatedAt"`,
    [recordingId, seq, bytes, preferred, at, at],
  );
}

export async function setSegmentStatus(
  recordingId: string,
  seq: number,
  status: SegmentStatus,
  fields: { text?: string; error?: string; provider?: string; note?: string; preferred?: string } = {},
): Promise<void> {
  await write(
    `UPDATE segments SET status=$1, text=COALESCE($2, text), error=COALESCE($3, error),
       provider=COALESCE($4, provider), note=COALESCE($5, note), preferred=COALESCE($6, preferred), "updatedAt"=$7
     WHERE "recordingId"=$8 AND seq=$9`,
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
    ],
  );
}

export async function segmentPreference(recordingId: string, seq: number): Promise<string> {
  const [row] = await rows<{ preferred: string }>(
    `SELECT preferred FROM segments WHERE "recordingId"=$1 AND seq=$2`,
    [recordingId, seq],
  );
  return row?.preferred ?? "";
}

export async function listSegments(recordingId: string): Promise<SegmentInfo[]> {
  return rows<SegmentInfo>(
    `SELECT seq,status,text,error,provider,note FROM segments WHERE "recordingId"=$1 ORDER BY seq`,
    [recordingId],
  );
}

export async function getSegment(
  recordingId: string,
  seq: number,
): Promise<SegmentInfo | null> {
  const [r] = await rows<SegmentInfo>(
    `SELECT seq,status,text,error,provider,note FROM segments WHERE "recordingId"=$1 AND seq=$2`,
    [recordingId, seq],
  );
  return r ?? null;
}

/** Tail of the transcript before `seq` — context prompt for continuity. */
export async function transcriptTailBefore(recordingId: string, seq: number): Promise<string> {
  const list = await rows<{ text: string }>(
    `SELECT text FROM segments WHERE "recordingId"=$1 AND seq<$2 AND status='done' ORDER BY seq`,
    [recordingId, seq],
  );
  return list
    .map((r) => r.text)
    .join(" ")
    .slice(-300);
}

/** Segments left `uploaded` or `transcribing` when the server last stopped. */
export async function listPendingSegments(): Promise<{ recordingId: string; seq: number }[]> {
  return rows<{ recordingId: string; seq: number }>(
    `SELECT "recordingId", seq FROM segments WHERE status IN ('uploaded','transcribing')
     ORDER BY "recordingId" COLLATE "C", seq`,
  );
}

/* ─── Adherence (patient-logged) ──────────────────────────────────────── */

export async function setAdherence(
  sessionId: string,
  day: string,
  exIdx: number,
  done: boolean,
): Promise<void> {
  await write(
    `INSERT INTO adherence("sessionId",day,"exIdx",done,"updatedAt") VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT("sessionId",day,"exIdx") DO UPDATE SET done=excluded.done, "updatedAt"=excluded."updatedAt"`,
    [sessionId, day, exIdx, done ? 1 : 0, nowIso()],
  );
}

export async function setPainLog(sessionId: string, day: string, pain: number): Promise<void> {
  await write(
    `INSERT INTO pain_logs("sessionId",day,pain,"updatedAt") VALUES ($1,$2,$3,$4)
     ON CONFLICT("sessionId",day) DO UPDATE SET pain=excluded.pain, "updatedAt"=excluded."updatedAt"`,
    [sessionId, day, pain, nowIso()],
  );
}

export async function listAdherence(
  sessionId: string,
): Promise<{ day: string; exIdx: number; done: boolean }[]> {
  return (
    await rows<{ day: string; exIdx: number; done: number }>(
      `SELECT day,"exIdx",done FROM adherence WHERE "sessionId"=$1 ORDER BY day COLLATE "C","exIdx"`,
      [sessionId],
    )
  ).map((r) => ({ day: r.day, exIdx: r.exIdx, done: !!r.done }));
}

export async function listPainLogs(
  sessionId: string,
): Promise<{ day: string; pain: number; updatedAt: string }[]> {
  return rows<{ day: string; pain: number; updatedAt: string }>(
    `SELECT day,pain,"updatedAt" FROM pain_logs WHERE "sessionId"=$1 ORDER BY day COLLATE "C"`,
    [sessionId],
  );
}

/** Latest adherence or pain log for a session (ISO text), or null when none. */
export async function lastLogAt(sessionId: string): Promise<string | null> {
  const [{ t }] = await rows<{ t: string | null }>(
    `SELECT MAX(t COLLATE "C") AS t FROM (
       SELECT MAX("updatedAt" COLLATE "C") AS t FROM adherence WHERE "sessionId"=$1
       UNION ALL
       SELECT MAX("updatedAt" COLLATE "C") AS t FROM pain_logs WHERE "sessionId"=$1
     ) AS logs`,
    [sessionId],
  );
  return t ?? null;
}
