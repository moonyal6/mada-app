import "server-only";
import Database from "better-sqlite3";
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

/** All server state lives under this directory (gitignored). */
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS patients(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  fileNo TEXT NOT NULL DEFAULT '',
  age INTEGER,
  sex TEXT NOT NULL DEFAULT '',
  caseKey TEXT NOT NULL,
  complaint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'نشط',
  createdAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appointments(
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id),
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'محجوز'
);
CREATE TABLE IF NOT EXISTS invoices(
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id),
  date TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',
  total REAL NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inventory(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  min INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'قطعة'
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  patientId TEXT NOT NULL REFERENCES patients(id),
  status TEXT NOT NULL DEFAULT 'draft',
  therapistName TEXT NOT NULL DEFAULT '',
  step INTEGER NOT NULL DEFAULT 0,
  dialogue TEXT NOT NULL DEFAULT '',
  assessment TEXT NOT NULL DEFAULT '',
  dx TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  sessionsCount TEXT NOT NULL DEFAULT '',
  frequency TEXT NOT NULL DEFAULT '',
  home TEXT NOT NULL DEFAULT '',
  follow TEXT NOT NULL DEFAULT '',
  pain TEXT NOT NULL DEFAULT '',
  advice TEXT NOT NULL DEFAULT '',
  planNotes TEXT NOT NULL DEFAULT '',
  selected TEXT NOT NULL DEFAULT '{}',
  suggestedDx TEXT NOT NULL DEFAULT '[]',
  report TEXT NOT NULL DEFAULT '',
  sealed INTEGER NOT NULL DEFAULT 0,
  sealDate TEXT NOT NULL DEFAULT '',
  handoutToken TEXT NOT NULL UNIQUE,
  consentAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  finishedAt TEXT
);
CREATE TABLE IF NOT EXISTS recordings(
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(id),
  mime TEXT NOT NULL DEFAULT '',
  startedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments(
  recordingId TEXT NOT NULL REFERENCES recordings(id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  text TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(recordingId, seq)
);
CREATE TABLE IF NOT EXISTS adherence(
  sessionId TEXT NOT NULL REFERENCES sessions(id),
  day TEXT NOT NULL,
  exIdx INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 1,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(sessionId, day, exIdx)
);
CREATE TABLE IF NOT EXISTS pain_logs(
  sessionId TEXT NOT NULL REFERENCES sessions(id),
  day TEXT NOT NULL,
  pain INTEGER NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY(sessionId, day)
);
CREATE INDEX IF NOT EXISTS idx_appts_date ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_sessions_patient ON sessions(patientId);
CREATE INDEX IF NOT EXISTS idx_segments_status ON segments(status);
`;

/**
 * Additive column migrations. The schema above only runs CREATE TABLE IF NOT
 * EXISTS, so a column added later never reaches an existing database; each
 * entry here is checked against PRAGMA table_info and applied once. Safe to
 * run on every start.
 */
const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  {
    table: "sessions",
    column: "therapistName",
    ddl: "ALTER TABLE sessions ADD COLUMN therapistName TEXT NOT NULL DEFAULT ''",
  },
];

function migrate(db: Database.Database) {
  for (const m of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as {
      name: string;
    }[];
    if (!cols.some((c) => c.name === m.column)) db.exec(m.ddl);
  }
}

function seed(db: Database.Database) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM patients").get() as {
    n: number;
  };
  if (count.n > 0) return;

  const today = clinicToday();
  const at = nowIso();
  // Demo data mirrors the prototype's seed — minus the hardcoded adherence
  // percentages, which now only ever come from real patient logs.
  const insP = db.prepare(
    `INSERT INTO patients(id,name,phone,fileNo,age,sex,caseKey,complaint,status,createdAt)
     VALUES (@id,@name,@phone,@fileNo,@age,@sex,@caseKey,@complaint,@status,@createdAt)`,
  );
  insP.run({
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
  });
  insP.run({
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
  });
  insP.run({
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
  });

  const insA = db.prepare(
    "INSERT INTO appointments(id,patientId,date,time,type,status) VALUES (?,?,?,?,?,?)",
  );
  insA.run("a1", "p1", today, "09:00", "متابعة", "محجوز");
  insA.run("a2", "p3", today, "10:30", "كشف", "محجوز");
  insA.run("a3", "p2", today, "12:00", "متابعة", "حضر");

  db.prepare(
    "INSERT INTO invoices(id,patientId,date,items,total,paid) VALUES (?,?,?,?,?,?)",
  ).run(
    "i1",
    "p2",
    today,
    JSON.stringify([{ desc: "جلسة علاج طبيعي", amount: 300 }]),
    300,
    1,
  );

  const insN = db.prepare(
    "INSERT INTO inventory(id,name,qty,min,unit) VALUES (?,?,?,?,?)",
  );
  insN.run("n1", "أقطاب كهربائية (Electrodes)", 6, 10, "عبوة");
  insN.run("n2", "جل الموجات فوق الصوتية", 12, 5, "عبوة");
  insN.run("n3", "أشرطة مقاومة", 3, 8, "قطعة");
  insN.run("n4", "كمادات جل", 15, 6, "قطعة");
}

declare global {
  var __madaDb: Database.Database | undefined;
}

/** One connection per process; survives dev HMR via globalThis. */
export function getDb(): Database.Database {
  if (globalThis.__madaDb) return globalThis.__madaDb;
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "mada.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  globalThis.__madaDb = db;
  return db;
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

export function listPatients(): Patient[] {
  return (
    getDb().prepare("SELECT * FROM patients ORDER BY createdAt DESC, id").all() as Row[]
  ).map(toPatient);
}

export function getPatient(id: string): Patient | null {
  const r = getDb().prepare("SELECT * FROM patients WHERE id=?").get(id) as
    | Row
    | undefined;
  return r ? toPatient(r) : null;
}

export function createPatient(
  p: Omit<Patient, "id" | "createdAt">,
): Patient {
  const patient: Patient = { ...p, id: uid("p"), createdAt: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO patients(id,name,phone,fileNo,age,sex,caseKey,complaint,status,createdAt)
       VALUES (@id,@name,@phone,@fileNo,@age,@sex,@caseKey,@complaint,@status,@createdAt)`,
    )
    .run(patient);
  return patient;
}

export function nextFileNo(): string {
  const n = (
    getDb().prepare("SELECT COUNT(*) AS n FROM patients").get() as { n: number }
  ).n;
  return String(1042 + n);
}

/* ─── Appointments ────────────────────────────────────────────────────── */

export function listAppointments(date?: string): Appointment[] {
  const db = getDb();
  const rows = date
    ? db.prepare("SELECT * FROM appointments WHERE date=? ORDER BY time").all(date)
    : db.prepare("SELECT * FROM appointments ORDER BY date DESC, time").all();
  return rows as Appointment[];
}

export function createAppointment(
  a: Omit<Appointment, "id" | "status">,
): Appointment {
  const appt: Appointment = { ...a, id: uid("a"), status: "محجوز" };
  getDb()
    .prepare(
      "INSERT INTO appointments(id,patientId,date,time,type,status) VALUES (@id,@patientId,@date,@time,@type,@status)",
    )
    .run(appt);
  return appt;
}

export function setAppointmentStatus(id: string, status: string): boolean {
  return (
    getDb()
      .prepare("UPDATE appointments SET status=? WHERE id=?")
      .run(status, id).changes > 0
  );
}

/* ─── Invoices ────────────────────────────────────────────────────────── */

export function listInvoices(patientId?: string): Invoice[] {
  const db = getDb();
  const rows = patientId
    ? db.prepare("SELECT * FROM invoices WHERE patientId=? ORDER BY date DESC, id DESC").all(patientId)
    : db.prepare("SELECT * FROM invoices ORDER BY date DESC, id DESC").all();
  return (rows as Row[]).map(toInvoice);
}

export function createInvoice(inv: Omit<Invoice, "id">): Invoice {
  const invoice: Invoice = { ...inv, id: uid("i") };
  getDb()
    .prepare(
      "INSERT INTO invoices(id,patientId,date,items,total,paid) VALUES (?,?,?,?,?,?)",
    )
    .run(
      invoice.id,
      invoice.patientId,
      invoice.date,
      JSON.stringify(invoice.items),
      invoice.total,
      invoice.paid ? 1 : 0,
    );
  return invoice;
}

export function markInvoicePaid(id: string): boolean {
  return (
    getDb().prepare("UPDATE invoices SET paid=1 WHERE id=?").run(id).changes > 0
  );
}

/* ─── Inventory ───────────────────────────────────────────────────────── */

export function listInventory(): InventoryItem[] {
  return getDb()
    .prepare("SELECT * FROM inventory ORDER BY rowid")
    .all() as InventoryItem[];
}

export function createInventoryItem(
  item: Omit<InventoryItem, "id">,
): InventoryItem {
  const it: InventoryItem = { ...item, id: uid("n") };
  getDb()
    .prepare("INSERT INTO inventory(id,name,qty,min,unit) VALUES (?,?,?,?,?)")
    .run(it.id, it.name, it.qty, it.min, it.unit);
  return it;
}

export function adjustInventory(id: string, delta: number): boolean {
  return (
    getDb()
      .prepare("UPDATE inventory SET qty=MAX(0, qty + ?) WHERE id=?")
      .run(delta, id).changes > 0
  );
}

/* ─── Sessions ────────────────────────────────────────────────────────── */

export function listSessions(patientId?: string): ClinicalSession[] {
  const db = getDb();
  const rows = patientId
    ? db.prepare("SELECT * FROM sessions WHERE patientId=? ORDER BY createdAt DESC").all(patientId)
    : db.prepare("SELECT * FROM sessions ORDER BY createdAt DESC").all();
  return (rows as Row[]).map(toSession);
}

export function getSession(id: string): ClinicalSession | null {
  const r = getDb().prepare("SELECT * FROM sessions WHERE id=?").get(id) as
    | Row
    | undefined;
  return r ? toSession(r) : null;
}

export function getSessionByToken(token: string): ClinicalSession | null {
  const r = getDb()
    .prepare("SELECT * FROM sessions WHERE handoutToken=?")
    .get(token) as Row | undefined;
  return r ? toSession(r) : null;
}

/** `therapistName` is stamped once here and never patched afterwards. */
export function createSession(
  patientId: string,
  therapistName = "",
): ClinicalSession {
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
  getDb()
    .prepare(
      `INSERT INTO sessions(id,patientId,status,therapistName,step,dialogue,assessment,dx,date,sessionsCount,frequency,home,follow,pain,advice,planNotes,selected,suggestedDx,report,sealed,sealDate,handoutToken,consentAt,createdAt,updatedAt,finishedAt)
       VALUES (@id,@patientId,@status,@therapistName,@step,@dialogue,@assessment,@dx,@date,@sessionsCount,@frequency,@home,@follow,@pain,@advice,@planNotes,@selectedJson,@suggestedDxJson,@report,@sealedInt,@sealDate,@handoutToken,@consentAt,@createdAt,@updatedAt,@finishedAt)`,
    )
    .run({
      ...session,
      selectedJson: JSON.stringify(session.selected),
      suggestedDxJson: JSON.stringify(session.suggestedDx),
      sealedInt: session.sealed ? 1 : 0,
    });
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
export function patchSession(
  id: string,
  patch: SessionDraftPatch,
): ClinicalSession | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: nowIso() };
  for (const f of DRAFT_FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    if (f === "selected") {
      sets.push("selected=@selected");
      params.selected = JSON.stringify(v ?? {});
    } else if (f === "suggestedDx") {
      sets.push("suggestedDx=@suggestedDx");
      params.suggestedDx = JSON.stringify(v ?? []);
    } else if (f === "sealed") {
      sets.push("sealed=@sealed");
      params.sealed = v ? 1 : 0;
    } else {
      sets.push(`${f}=@${f}`);
      params[f] = v;
    }
  }
  if (sets.length) {
    const res = getDb()
      .prepare(
        `UPDATE sessions SET ${sets.join(",")}, updatedAt=@updatedAt WHERE id=@id AND status='draft'`,
      )
      .run(params);
    if (res.changes === 0) return getSession(id);
  }
  return getSession(id);
}

export function setSessionConsent(id: string): ClinicalSession | null {
  getDb()
    .prepare("UPDATE sessions SET consentAt=?, updatedAt=? WHERE id=? AND consentAt IS NULL")
    .run(nowIso(), nowIso(), id);
  return getSession(id);
}

/** Finish: marks final and creates the session invoice, atomically. */
export function finishSession(id: string): ClinicalSession | null {
  const db = getDb();
  const tx = db.transaction(() => {
    const at = nowIso();
    const res = db
      .prepare(
        "UPDATE sessions SET status='final', finishedAt=?, updatedAt=? WHERE id=? AND status='draft'",
      )
      .run(at, at, id);
    if (res.changes > 0) {
      // Same behaviour as the prototype: an unpaid invoice per finished session.
      const session = getSession(id)!;
      createInvoice({
        patientId: session.patientId,
        date: clinicToday(),
        items: [{ desc: "جلسة علاج طبيعي", amount: 300 }],
        total: 300,
        paid: false,
      });
    }
  });
  tx();
  return getSession(id);
}

/* ─── Recordings & segments ───────────────────────────────────────────── */

export function createRecording(sessionId: string, mime: string): string {
  const id = uid("r");
  getDb()
    .prepare("INSERT INTO recordings(id,sessionId,mime,startedAt) VALUES (?,?,?,?)")
    .run(id, sessionId, mime, nowIso());
  fs.mkdirSync(path.join(RECORDINGS_DIR, id), { recursive: true });
  return id;
}

export function getRecording(
  id: string,
): { id: string; sessionId: string; mime: string; startedAt: string } | null {
  return (
    (getDb().prepare("SELECT * FROM recordings WHERE id=?").get(id) as {
      id: string;
      sessionId: string;
      mime: string;
      startedAt: string;
    }) ?? null
  );
}

export function segmentPath(recordingId: string, seq: number, ext: string): string {
  return path.join(RECORDINGS_DIR, recordingId, `${seq}.${ext}`);
}

export function upsertSegment(
  recordingId: string,
  seq: number,
  bytes: number,
): void {
  const at = nowIso();
  getDb()
    .prepare(
      `INSERT INTO segments(recordingId,seq,status,text,error,bytes,createdAt,updatedAt)
       VALUES (?,?,'uploaded','','',?,?,?)
       ON CONFLICT(recordingId,seq) DO UPDATE SET status='uploaded', error='', bytes=excluded.bytes, updatedAt=excluded.updatedAt`,
    )
    .run(recordingId, seq, bytes, at, at);
}

export function setSegmentStatus(
  recordingId: string,
  seq: number,
  status: SegmentStatus,
  fields: { text?: string; error?: string } = {},
): void {
  getDb()
    .prepare(
      "UPDATE segments SET status=?, text=COALESCE(?, text), error=COALESCE(?, error), updatedAt=? WHERE recordingId=? AND seq=?",
    )
    .run(status, fields.text ?? null, fields.error ?? null, nowIso(), recordingId, seq);
}

export function listSegments(recordingId: string): SegmentInfo[] {
  return getDb()
    .prepare("SELECT seq,status,text,error FROM segments WHERE recordingId=? ORDER BY seq")
    .all(recordingId) as SegmentInfo[];
}

export function getSegment(
  recordingId: string,
  seq: number,
): SegmentInfo | null {
  return (
    (getDb()
      .prepare("SELECT seq,status,text,error FROM segments WHERE recordingId=? AND seq=?")
      .get(recordingId, seq) as SegmentInfo) ?? null
  );
}

/** Tail of the transcript before `seq` — context prompt for continuity. */
export function transcriptTailBefore(recordingId: string, seq: number): string {
  const rows = getDb()
    .prepare(
      "SELECT text FROM segments WHERE recordingId=? AND seq<? AND status='done' ORDER BY seq",
    )
    .all(recordingId, seq) as { text: string }[];
  return rows
    .map((r) => r.text)
    .join(" ")
    .slice(-300);
}

/* ─── Adherence (patient-logged) ──────────────────────────────────────── */

export function setAdherence(
  sessionId: string,
  day: string,
  exIdx: number,
  done: boolean,
): void {
  getDb()
    .prepare(
      `INSERT INTO adherence(sessionId,day,exIdx,done,updatedAt) VALUES (?,?,?,?,?)
       ON CONFLICT(sessionId,day,exIdx) DO UPDATE SET done=excluded.done, updatedAt=excluded.updatedAt`,
    )
    .run(sessionId, day, exIdx, done ? 1 : 0, nowIso());
}

export function setPainLog(sessionId: string, day: string, pain: number): void {
  getDb()
    .prepare(
      `INSERT INTO pain_logs(sessionId,day,pain,updatedAt) VALUES (?,?,?,?)
       ON CONFLICT(sessionId,day) DO UPDATE SET pain=excluded.pain, updatedAt=excluded.updatedAt`,
    )
    .run(sessionId, day, pain, nowIso());
}

export function listAdherence(
  sessionId: string,
): { day: string; exIdx: number; done: boolean }[] {
  return (
    getDb()
      .prepare("SELECT day,exIdx,done FROM adherence WHERE sessionId=? ORDER BY day,exIdx")
      .all(sessionId) as { day: string; exIdx: number; done: number }[]
  ).map((r) => ({ day: r.day, exIdx: r.exIdx, done: !!r.done }));
}

export function listPainLogs(
  sessionId: string,
): { day: string; pain: number; updatedAt: string }[] {
  return getDb()
    .prepare("SELECT day,pain,updatedAt FROM pain_logs WHERE sessionId=? ORDER BY day")
    .all(sessionId) as { day: string; pain: number; updatedAt: string }[];
}
