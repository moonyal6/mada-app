// The baseline scenario: named steps, run in order against a fresh instance.
//
// Every deterministic API route on the seed, plus the handout page (#7, 7b).
// Reads come after writes, so the effect of each write is recorded too.
// Excluded on purpose: the Claude and STT routes, /api/debug/sentry, and the
// segment PUT and retry (they start the asynchronous STT queue).
//
// A step is { name, method, path, body?, headers?, finding?, statusOnly?,
// extract? }. `path` and `body` may be functions of the earlier steps' raw
// response bodies, keyed by step name, for steps that need an ID an earlier
// step created. `finding` marks a recorded response as a known bug; `--record`
// copies it into the fixture and every replay prints it. `statusOnly` records
// and compares the status alone; the body is not recorded. `extract` turns a
// raw body into what gets recorded. `order` is for a list sorted by random
// IDs: the rule is checked on the raw response and the items are compared
// in a fixed order (see `OrderRule` in ../baseline.mjs).
//
// The text below is test data, not clinical content.

import { handoutView } from "./handout.mjs";

/** @typedef {import("../baseline.mjs").Step} Step */
/** @typedef {import("../baseline.mjs").Bodies} Bodies */

/**
 * A field of an object in an earlier step's response.
 * @param {string} step @param {string} key @param {string} [field]
 */
const ref = (step, key, field = "id") => (/** @type {Bodies} */ p) =>
  /** @type {any} */ (p[step])[key][field];

const pFull = ref("patients: full create", "patient");
const pMin = ref("patients: minimal create (auto fileNo)", "patient");
const apptToday = ref("appointments: create today", "appointment");
const invoice = ref("invoices: create 150.5", "invoice");
const session = ref("sessions: create, no therapist", "session");
const token = ref("sessions: create, no therapist", "session", "handoutToken");
/** The clinic date, as the server reported it before any write. @param {Bodies} p */
const today = (p) => /** @type {any} */ (p["dashboard: before"]).today;
const OTHER_DAY = "2026-01-15";

/** Descending, comparing strings code unit by code unit like SQLite's BINARY collation. */
const desc = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * `listInvoices`: every invoice is dated the day it's created, so within a
 * run the order comes from the random IDs.
 * @type {import("../baseline.mjs").OrderRule}
 */
const INVOICE_ORDER = {
  list: "invoices",
  rule: "date DESC, id DESC",
  compare: (a, b) => desc(a.date, b.date) || desc(a.id, b.id),
};

/** @type {Step[]} */
export const steps = [
  // ─── Before any write ───
  { name: "patients: seed list", method: "GET", path: "/api/patients" },
  { name: "patients: p1 before", method: "GET", path: "/api/patients/p1" },
  { name: "dashboard: before", method: "GET", path: "/api/dashboard" },
  { name: "followup: before", method: "GET", path: "/api/followup" },
  { name: "inventory: seed list", method: "GET", path: "/api/inventory" },
  { name: "invoices: seed list", method: "GET", path: "/api/invoices", order: INVOICE_ORDER },
  { name: "appointments: seed list", method: "GET", path: "/api/appointments" },
  { name: "sessions: none yet", method: "GET", path: "/api/sessions" },

  // ─── Patients ───
  {
    name: "patients: full create",
    method: "POST",
    path: "/api/patients",
    body: {
      name: "  نورة خالد الشمري ",
      phone: " 0501112223 ",
      fileNo: " 2001 ",
      age: 52,
      sex: "أنثى",
      caseKey: "shoulder",
      complaint: " شكوى تجريبية ",
    },
  },
  {
    name: "patients: minimal create (auto fileNo)",
    method: "POST",
    path: "/api/patients",
    body: { name: "عمر يوسف", caseKey: "ankle" },
  },
  {
    name: "patients: age 0 becomes null",
    method: "POST",
    path: "/api/patients",
    body: { name: "ليان سامي", caseKey: "neck", age: 0 },
  },
  {
    name: "patients: bad caseKey → 400",
    method: "POST",
    path: "/api/patients",
    body: { name: "اسم", caseKey: "elbow" },
  },
  {
    name: "patients: bad JSON → 400",
    method: "POST",
    path: "/api/patients",
    body: "{not json",
  },
  { name: "patients: list after creates", method: "GET", path: "/api/patients" },
  { name: "patients: unknown → 404", method: "GET", path: "/api/patients/p-unknown" },

  // ─── Appointments ───
  {
    name: "appointments: create today",
    method: "POST",
    path: "/api/appointments",
    body: (p) => ({ patientId: pFull(p), date: today(p), time: "11:15", type: "كشف" }),
  },
  {
    name: "appointments: create another day",
    method: "POST",
    path: "/api/appointments",
    body: { patientId: "p3", date: OTHER_DAY, time: "08:30", type: "متابعة" },
  },
  {
    name: "appointments: bad date format → 400",
    method: "POST",
    path: "/api/appointments",
    body: { patientId: "p3", date: "15/01/2026", time: "08:30", type: "متابعة" },
  },
  {
    name: "appointments: unknown patient → 500",
    method: "POST",
    path: "/api/appointments",
    body: { patientId: "p-unknown", date: OTHER_DAY, time: "09:00", type: "كشف" },
    statusOnly: true,
    finding:
      "unknown patientId → 500: the foreign key rejects the insert and the route doesn't catch it; should be 400. Status only: the body was not recorded. Fix after #8.",
  },
  { name: "appointments: all", method: "GET", path: "/api/appointments" },
  {
    name: "appointments: today",
    method: "GET",
    path: (p) => `/api/appointments?date=${today(p)}`,
  },
  {
    name: "appointments: another day",
    method: "GET",
    path: `/api/appointments?date=${OTHER_DAY}`,
  },
  {
    name: "appointments: set status",
    method: "PATCH",
    path: (p) => `/api/appointments/${apptToday(p)}`,
    body: { status: "ملغى" },
  },
  {
    name: "appointments: status not allowed → 400",
    method: "PATCH",
    path: (p) => `/api/appointments/${apptToday(p)}`,
    body: { status: "منتهٍ" },
  },
  {
    name: "appointments: unknown → 404",
    method: "PATCH",
    path: "/api/appointments/a-unknown",
    body: { status: "حضر" },
  },

  // ─── Invoices ───
  {
    name: "invoices: create 150.5",
    method: "POST",
    path: "/api/invoices",
    body: (p) => ({ patientId: pFull(p), desc: " جلسة تقييم ", amount: 150.5 }),
  },
  {
    name: "invoices: default description",
    method: "POST",
    path: "/api/invoices",
    body: (p) => ({ patientId: pMin(p), amount: 200 }),
  },
  {
    name: "invoices: missing patient → 400",
    method: "POST",
    path: "/api/invoices",
    body: { amount: 10 },
  },
  {
    name: "invoices: unknown patient → 500",
    method: "POST",
    path: "/api/invoices",
    body: { patientId: "p-unknown", amount: 10 },
    statusOnly: true,
    finding:
      "unknown patientId → 500: the foreign key rejects the insert and the route doesn't catch it; should be 400. Status only: the body was not recorded. Fix after #8.",
  },
  {
    name: "invoices: mark paid",
    method: "PATCH",
    path: (p) => `/api/invoices/${invoice(p)}`,
    body: { paid: true },
  },
  {
    name: "invoices: paid false → 400",
    method: "PATCH",
    path: (p) => `/api/invoices/${invoice(p)}`,
    body: { paid: false },
  },
  {
    name: "invoices: unknown → 404",
    method: "PATCH",
    path: "/api/invoices/i-unknown",
    body: { paid: true },
  },
  { name: "invoices: list", method: "GET", path: "/api/invoices", order: INVOICE_ORDER },

  // ─── Inventory ───
  {
    name: "inventory: create with defaults",
    method: "POST",
    path: "/api/inventory",
    body: { name: " شاش " },
  },
  {
    name: "inventory: negative qty becomes 0",
    method: "POST",
    path: "/api/inventory",
    body: { name: "لاصق", qty: -5, min: 2.9, unit: " علبة " },
  },
  {
    name: "inventory: delta −100 clamps to 0",
    method: "PATCH",
    path: "/api/inventory/n2",
    body: { delta: -100 },
  },
  {
    name: "inventory: delta 2.7 becomes 2",
    method: "PATCH",
    path: "/api/inventory/n2",
    body: { delta: 2.7 },
  },
  {
    name: "inventory: non-number → 400",
    method: "PATCH",
    path: "/api/inventory/n1",
    body: { delta: "5" },
  },
  {
    name: "inventory: unknown → 404",
    method: "PATCH",
    path: "/api/inventory/n-unknown",
    body: { delta: 1 },
  },
  { name: "inventory: list after writes", method: "GET", path: "/api/inventory" },

  // ─── Sessions ───
  {
    name: "sessions: create, no therapist",
    method: "POST",
    path: "/api/sessions",
    body: { patientId: "p1" },
  },
  {
    name: "sessions: create, therapistName in body",
    method: "POST",
    path: "/api/sessions",
    body: { patientId: "p3", therapistName: "  د.  سلمى   الحربي " },
  },
  {
    name: "sessions: create, therapist cookie",
    method: "POST",
    path: "/api/sessions",
    body: { patientId: "p3" },
    headers: { cookie: `mada_therapist=${encodeURIComponent("د. خالد العمري")}` },
  },
  {
    name: "sessions: unknown patient → 404",
    method: "POST",
    path: "/api/sessions",
    body: { patientId: "p-unknown" },
  },
  { name: "sessions: list", method: "GET", path: "/api/sessions" },
  { name: "sessions: p3 only", method: "GET", path: "/api/sessions?patientId=p3" },
  { name: "sessions: read", method: "GET", path: (p) => `/api/sessions/${session(p)}` },
  { name: "sessions: unknown → 404", method: "GET", path: "/api/sessions/s-unknown" },

  // ─── Consent and recordings ───
  {
    name: "recordings: before consent → 409",
    method: "POST",
    path: "/api/recordings",
    body: (p) => ({ sessionId: session(p), mime: "audio/webm" }),
  },
  {
    name: "recordings: unknown session → 404",
    method: "POST",
    path: "/api/recordings",
    body: { sessionId: "s-unknown", mime: "audio/webm" },
  },
  { name: "sessions: consent", method: "POST", path: (p) => `/api/sessions/${session(p)}/consent` },
  {
    name: "sessions: consent twice",
    method: "POST",
    path: (p) => `/api/sessions/${session(p)}/consent`,
  },
  { name: "sessions: consent unknown → 404", method: "POST", path: "/api/sessions/s-unknown/consent" },
  {
    name: "recordings: after consent → 201",
    method: "POST",
    path: "/api/recordings",
    body: (p) => ({ sessionId: session(p), mime: "audio/webm" }),
  },
  {
    name: "recordings: read, no segments",
    method: "GET",
    path: (p) => `/api/recordings/${/** @type {any} */ (p["recordings: after consent → 201"]).id}`,
  },
  { name: "recordings: unknown → 404", method: "GET", path: "/api/recordings/r-unknown" },

  // ─── Draft autosave ───
  {
    name: "sessions: patch every whitelisted field",
    method: "PATCH",
    path: (p) => `/api/sessions/${session(p)}`,
    body: {
      step: 2.6,
      dialogue: "نص الحوار",
      assessment: "نص التقييم",
      dx: "انطباع اعتمده المعالج",
      date: "2026-09-15",
      sessionsCount: "٦ جلسات",
      frequency: "مرتين أسبوعياً",
      home: "يومياً",
      follow: "بعد أسبوعين",
      pain: "٥",
      advice: "نص النصائح",
      planNotes: "ملاحظات الخطة",
      report: "نص التقرير",
      sealed: true,
      sealDate: "2026-09-16",
      selected: {
        x1: { ar: "تمرين أ", en: "Exercise A", desc: "وصف أ", url: "https://example.com/a", source: "case" },
        x2: { ar: "تمرين ب", en: "Exercise B", desc: "وصف ب", url: "", source: "case" },
        x3: { ar: "تمرين ج", en: "Exercise C", desc: "وصف ج", url: "", image: "/x3.svg", source: "added" },
      },
      suggestedDx: ["انطباع مقترح أ", "انطباع مقترح ب"],
      status: "final",
      therapistName: "لا يُحفظ",
    },
  },
  {
    name: "sessions: step 7 ignored",
    method: "PATCH",
    path: (p) => `/api/sessions/${session(p)}`,
    body: { step: 7 },
  },
  {
    name: "sessions: non-string suggestedDx entries dropped",
    method: "PATCH",
    path: (p) => `/api/sessions/${session(p)}`,
    body: { suggestedDx: ["انطباع مقترح أ", 3, null, { x: 1 }, "انطباع مقترح ج"] },
  },

  // ─── Finish ───
  {
    name: "sessions: finish (creates an unpaid 300 invoice)",
    method: "POST",
    path: (p) => `/api/sessions/${session(p)}/finish`,
  },
  {
    name: "sessions: finish twice (no second invoice)",
    method: "POST",
    path: (p) => `/api/sessions/${session(p)}/finish`,
  },
  { name: "sessions: finish unknown → 404", method: "POST", path: "/api/sessions/s-unknown/finish" },
  {
    name: "sessions: patch after finish is returned unchanged",
    method: "PATCH",
    path: (p) => `/api/sessions/${session(p)}`,
    body: { dx: "تعديل بعد الإنهاء", step: 3 },
  },

  // ─── Patient handout log ───
  {
    name: "handout: check off exercise 0",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { exIdx: 0 },
  },
  {
    name: "handout: same exercise again (upsert)",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { exIdx: 0, done: true },
  },
  {
    name: "handout: check off exercise 2",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { exIdx: 2.9 },
  },
  {
    name: "handout: exIdx out of range → 400",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { exIdx: 3 },
  },
  {
    name: "handout: pain 7.6 becomes 8",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { pain: 7.6 },
  },
  {
    name: "handout: pain 11 → 400",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { pain: 11 },
  },
  {
    name: "handout: neither field → 400",
    method: "POST",
    path: (p) => `/api/handout/${token(p)}/log`,
    body: { note: "x" },
  },
  {
    name: "handout: bad token → 404",
    method: "POST",
    path: "/api/handout/not-a-token/log",
    body: { exIdx: 0 },
  },
  {
    name: "handout page: what the patient sees",
    method: "GET",
    path: (p) => `/h/${token(p)}`,
    extract: handoutView,
  },

  // ─── After every write ───
  { name: "patients: p1 after", method: "GET", path: "/api/patients/p1" },
  { name: "invoices: list after finish", method: "GET", path: "/api/invoices", order: INVOICE_ORDER },
  { name: "sessions: list after finish", method: "GET", path: "/api/sessions" },
  { name: "dashboard: after", method: "GET", path: "/api/dashboard" },
  { name: "followup: after", method: "GET", path: "/api/followup" },
];
