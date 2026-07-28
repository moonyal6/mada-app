import { fromAr } from "./arabic";
import { isCaseKey } from "./data/cases";
import { STEPS } from "./data/steps";
import { initialSessionState } from "./session-store";
import type { SelectedExercise, SessionState } from "./types";

/**
 * localStorage persistence for the trial build. One key holds everything —
 * the saved sessions and which one is open — so export/import and corruption
 * handling deal with a single JSON document.
 *
 * Every read path goes through normalizeState(), which rebuilds the state
 * object field by field from whatever was stored. Unknown fields are dropped,
 * missing ones fall back to the initial state, so a stale or hand-edited
 * store can never crash the reducer.
 */

export type SessionRecord = {
  id: string;
  /** ISO timestamp — when the session was first opened in the wizard. */
  openedAt: string;
  /** ISO timestamp — last autosave. */
  updatedAt: string;
  /** ISO timestamp of the most recent seal; "" while the report is unsealed. */
  sealedAt: string;
  state: SessionState;
};

export const STORAGE_KEY = "mada.store.v1";
/** Unreadable stores are stashed here (not deleted) before starting fresh. */
const BACKUP_KEY = "mada.store.unreadable";

export type ReadFailure = "unavailable" | "corrupt" | null;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function normalizeState(raw: unknown): SessionState {
  const base = initialSessionState;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const p = (r.patient ?? {}) as Record<string, unknown>;
  const d = (r.doctor ?? {}) as Record<string, unknown>;

  const selected: Record<string, SelectedExercise> = {};
  const selectedRaw = (r.selected ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(selectedRaw)) {
    if (!value || typeof value !== "object") continue;
    const e = value as Record<string, unknown>;
    if (!str(e.ar)) continue;
    selected[id] = {
      ar: str(e.ar),
      en: str(e.en),
      desc: str(e.desc),
      url: str(e.url),
      source: e.source === "case" ? "case" : "added",
    };
  }

  const caseKey = str(p.caseKey);
  const step =
    typeof r.step === "number" && Number.isInteger(r.step)
      ? Math.min(Math.max(r.step, 0), STEPS.length - 1)
      : 0;

  return {
    step,
    patient: {
      name: str(p.name),
      file: str(p.file),
      age: str(p.age),
      sex: str(p.sex) || base.patient.sex,
      caseKey: isCaseKey(caseKey) ? caseKey : base.patient.caseKey,
      complaint: str(p.complaint),
    },
    dialogue: str(r.dialogue),
    doctor: {
      dx: str(d.dx),
      date: str(d.date),
      sessions: str(d.sessions),
      frequency: str(d.frequency),
      home: str(d.home),
      follow: str(d.follow),
      pain: str(d.pain),
      advice: str(d.advice),
      planNotes: str(d.planNotes),
    },
    selected,
    genMode: r.genMode === "manual" ? "manual" : "direct",
    report: str(r.report),
    sealed: r.sealed === true,
    sealDate: str(r.sealDate),
    // A sealed report must never come back hidden.
    draftVisible: r.draftVisible === true || r.sealed === true,
  };
}

export function normalizeRecord(raw: unknown): SessionRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    openedAt: str(r.openedAt),
    updatedAt: str(r.updatedAt),
    sealedAt: str(r.sealedAt),
    state: normalizeState(r.state),
  };
}

export function readStore(): {
  sessions: SessionRecord[];
  activeId: string | null;
  failure: ReadFailure;
} {
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return { sessions: [], activeId: null, failure: "unavailable" };
  }
  if (text === null) return { sessions: [], activeId: null, failure: null };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.sessions))
      throw new Error("unexpected shape");
    const sessions = raw.sessions
      .map(normalizeRecord)
      .filter((r): r is SessionRecord => r !== null);
    return { sessions, activeId: str(raw.activeId) || null, failure: null };
  } catch {
    try {
      window.localStorage.setItem(BACKUP_KEY, text);
    } catch {
      // The backup is best-effort; the warning banner still shows.
    }
    return { sessions: [], activeId: null, failure: "corrupt" };
  }
}

export function writeStore(
  sessions: SessionRecord[],
  activeId: string | null,
): boolean {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, activeId, sessions }),
    );
    return true;
  } catch {
    return false;
  }
}

/** True once the session differs from a freshly opened wizard (the automatic
 *  session date does not count). Untouched sessions are never persisted. */
export function hasContent(s: SessionState): boolean {
  const base = initialSessionState;
  return (
    s.dialogue !== "" ||
    s.report !== "" ||
    s.sealed ||
    s.draftVisible ||
    Object.keys(s.selected).length > 0 ||
    s.patient.name !== "" ||
    s.patient.file !== "" ||
    s.patient.age !== "" ||
    s.patient.complaint !== "" ||
    s.patient.sex !== base.patient.sex ||
    s.patient.caseKey !== base.patient.caseKey ||
    (Object.entries(s.doctor) as [keyof SessionState["doctor"], string][]).some(
      ([field, value]) => field !== "date" && value !== "",
    )
  );
}

/** "٥ / ١٠" -> 5. Null when no pain score was recorded. */
function painScore(pain: string): number | null {
  const n = parseInt(fromAr(pain), 10);
  return Number.isNaN(n) ? null : n;
}

/** Minutes from open to seal — the number the trial is trying to produce. */
function documentationMinutes(openedAt: string, sealedAt: string): number | null {
  const opened = Date.parse(openedAt);
  const sealed = Date.parse(sealedAt);
  if (Number.isNaN(opened) || Number.isNaN(sealed)) return null;
  return Math.round(((sealed - opened) / 60000) * 10) / 10;
}

export function buildExportJson(sessions: SessionRecord[]): string {
  return JSON.stringify(
    {
      app: "mada",
      version: 1,
      exportedAt: new Date().toISOString(),
      // The usage numbers, readable without digging through session state.
      usage: sessions.map((r) => ({
        id: r.id,
        patient: r.state.patient.name,
        openedAt: r.openedAt,
        sealedAt: r.sealedAt,
        updatedAt: r.updatedAt,
        pain: r.state.doctor.pain,
        painScore: painScore(r.state.doctor.pain),
        documentationMinutes: documentationMinutes(r.openedAt, r.sealedAt),
      })),
      sessions,
    },
    null,
    2,
  );
}

/** Throws when the text is not a Mada backup. */
export function parseImportJson(text: string): SessionRecord[] {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || raw.app !== "mada" || !Array.isArray(raw.sessions))
    throw new Error("not a mada backup");
  return raw.sessions
    .map(normalizeRecord)
    .filter((r): r is SessionRecord => r !== null);
}

/** Merge by id — imported records win only when newer. Never deletes. */
export function mergeSessions(
  current: SessionRecord[],
  imported: SessionRecord[],
): { sessions: SessionRecord[]; added: number; updated: number } {
  const byId = new Map(current.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  for (const record of imported) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      added += 1;
    } else if (Date.parse(record.updatedAt) > Date.parse(existing.updatedAt)) {
      byId.set(record.id, record);
      updated += 1;
    }
  }
  return { sessions: [...byId.values()], added, updated };
}

export function sortByUpdated(sessions: SessionRecord[]): SessionRecord[] {
  return [...sessions].sort(
    (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  );
}
