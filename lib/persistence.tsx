"use client";

import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { initialSessionState, useSession } from "./session-store";
import {
  buildExportJson,
  hasContent,
  mergeSessions,
  parseImportJson,
  readStore,
  sortByUpdated,
  writeStore,
  type SessionRecord,
} from "./storage";
import type { SessionState } from "./types";

/**
 * Wraps the session reducer with localStorage persistence and the saved-
 * sessions list. The reducer stays pure; this provider watches its state and
 * writes through (debounced) to a single localStorage key.
 *
 * Storage failure is never fatal: the app keeps running on the in-memory
 * session and `storageNotice` carries the warning the UI must show.
 *
 * The paste-only report field is untouched by design: nothing here writes to
 * the DOM — restore goes through the reducer, and the paste textarea in
 * ManualPaste has no binding to session state.
 */

export type AppView = "home" | "session";

const NOTICE_UNAVAILABLE =
  "التخزين المحلي غير متاح في هذا المتصفح — تعمل الجلسة في الذاكرة فقط وستُفقد عند إغلاق الصفحة.";
const NOTICE_CORRUPT =
  "تعذّرت قراءة الجلسات المحفوظة، فبدأت المنصّة بقائمة فارغة. استورد نسخة احتياطية إن وُجدت.";
const NOTICE_WRITE =
  "تعذّر الحفظ التلقائي — قد تكون مساحة التخزين ممتلئة. صدّر بياناتك للاحتفاظ بنسخة.";

const SAVE_DEBOUNCE_MS = 200;

function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type PersistenceValue = {
  /** False until localStorage has been read (first client render). */
  ready: boolean;
  view: AppView;
  /** Saved sessions, most recently updated first. */
  records: SessionRecord[];
  /** Non-null when persistence is degraded; shown as a visible warning. */
  storageNotice: string | null;
  startNew: () => void;
  resume: (id: string) => void;
  /** New visit for a returning patient: carries patient data, diagnosis and
   *  the exercise basket; dialogue, report and pain start empty. */
  newVisit: (id: string) => void;
  goHome: () => void;
  exportAll: () => void;
  /** Returns null when the text is not a readable Mada backup. */
  importText: (text: string) => { added: number; updated: number } | null;
};

const PersistenceContext = createContext<PersistenceValue | null>(null);

export function PersistenceProvider({ children }: { children: ReactNode }) {
  const { state, dispatch } = useSession();

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<AppView>("home");
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);

  // Written only from effects and event handlers, never during render.
  const activeIdRef = useRef<string | null>(null);
  const openedAtRef = useRef("");
  const sealedAtRef = useRef("");
  const prevSealedRef = useRef(false);
  const lastSavedJsonRef = useRef("");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = (sessions: SessionRecord[], activeId: string | null) => {
    if (!writeStore(sessions, activeId))
      setStorageNotice((prev) => prev ?? NOTICE_WRITE);
  };

  /**
   * Writes the open session into the records list and localStorage, now.
   * Skips when nothing changed since the last save, so timestamps only move
   * on real edits. Returns the up-to-date records list for callers that
   * persist again as part of a transition.
   */
  const flushSave = (): SessionRecord[] => {
    const id = activeIdRef.current;
    if (!id || view !== "session") return records;
    const exists = records.some((r) => r.id === id);
    if (!exists && !hasContent(state)) return records;
    const json = JSON.stringify(state);
    if (exists && json === lastSavedJsonRef.current) return records;
    lastSavedJsonRef.current = json;
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id,
      openedAt: openedAtRef.current || now,
      updatedAt: now,
      sealedAt: sealedAtRef.current,
      state,
    };
    const next = [record, ...records.filter((r) => r.id !== id)];
    setRecords(next);
    persist(next, id);
    return next;
  };

  const flushOnHide = useEffectEvent(() => flushSave());

  // Load once on mount. An active session (mid-work refresh) resumes straight
  // into the wizard; otherwise the saved-sessions list is the landing view.
  //
  // One-time hydration from localStorage is a synchronizing effect: storage
  // does not exist during SSR, so the shell -> restored-UI cascade is the
  // intended behaviour, not an accident.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const { sessions, activeId, failure } = readStore();
    const sorted = sortByUpdated(sessions);
    setRecords(sorted);
    if (failure === "unavailable") setStorageNotice(NOTICE_UNAVAILABLE);
    else if (failure === "corrupt") setStorageNotice(NOTICE_CORRUPT);
    const active = activeId ? sorted.find((r) => r.id === activeId) : undefined;
    if (active) {
      activeIdRef.current = active.id;
      openedAtRef.current = active.openedAt;
      sealedAtRef.current = active.sealedAt;
      prevSealedRef.current = active.state.sealed;
      lastSavedJsonRef.current = JSON.stringify(active.state);
      dispatch({ type: "replace", state: active.state });
      setView("session");
    } else {
      // The saved-sessions landing list arrives with the continuity feature;
      // until then a fresh session opens directly, as before.
      activeIdRef.current = newSessionId();
      openedAtRef.current = new Date().toISOString();
      sealedAtRef.current = "";
      prevSealedRef.current = false;
      lastSavedJsonRef.current = "";
      setView("session");
    }
    setReady(true);
  }, [dispatch]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Debounced autosave on every session change. The timer captures this
  // render's `flushSave`, so it always writes exactly the state it saw.
  useEffect(() => {
    if (!ready || view !== "session" || !activeIdRef.current) return;
    // The seal moment is the usage timestamp the trial cares about.
    if (state.sealed && !prevSealedRef.current)
      sealedAtRef.current = new Date().toISOString();
    prevSealedRef.current = state.sealed;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => flushSave(), SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  });

  // A pending debounce must not be lost to a close or refresh.
  useEffect(() => {
    const onHide = () => flushOnHide();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, []);

  const openSession = (
    id: string,
    opened: string,
    sealed: string,
    next: SessionState,
    sessions: SessionRecord[],
  ) => {
    activeIdRef.current = id;
    openedAtRef.current = opened;
    sealedAtRef.current = sealed;
    prevSealedRef.current = next.sealed;
    lastSavedJsonRef.current = "";
    dispatch({ type: "replace", state: next });
    setView("session");
    persist(sessions, id);
  };

  const startNew = () => {
    const sessions = flushSave();
    openSession(
      newSessionId(),
      new Date().toISOString(),
      "",
      initialSessionState,
      sessions,
    );
  };

  const resume = (id: string) => {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    openSession(
      record.id,
      record.openedAt,
      record.sealedAt,
      record.state,
      records,
    );
  };

  const newVisit = (id: string) => {
    const record = records.find((r) => r.id === id);
    if (!record) return;
    const carried: SessionState = {
      ...initialSessionState,
      patient: { ...record.state.patient },
      doctor: { ...initialSessionState.doctor, dx: record.state.doctor.dx },
      selected: { ...record.state.selected },
    };
    // Fresh id and opening time: the visit is a new documentation session.
    openSession(newSessionId(), new Date().toISOString(), "", carried, records);
  };

  const goHome = () => {
    const sessions = flushSave();
    activeIdRef.current = null;
    lastSavedJsonRef.current = "";
    dispatch({ type: "replace", state: initialSessionState });
    setView("home");
    // Unconditional: even when the flush had nothing to write, the stored
    // activeId must clear or a refresh would silently re-enter the session.
    persist(sessions, null);
  };

  const exportAll = () => {
    const blob = new Blob([buildExportJson(records)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mada-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importText = (text: string) => {
    let imported: SessionRecord[];
    try {
      imported = parseImportJson(text);
    } catch {
      return null;
    }
    const { sessions, added, updated } = mergeSessions(records, imported);
    const next = sortByUpdated(sessions);
    setRecords(next);
    persist(next, activeIdRef.current);
    return { added, updated };
  };

  const value: PersistenceValue = {
    ready,
    view,
    records,
    storageNotice,
    startNew,
    resume,
    newVisit,
    goHome,
    exportAll,
    importText,
  };

  return (
    <PersistenceContext.Provider value={value}>
      {children}
    </PersistenceContext.Provider>
  );
}

export function usePersistence(): PersistenceValue {
  const ctx = useContext(PersistenceContext);
  if (!ctx)
    throw new Error("usePersistence must be used inside <PersistenceProvider>");
  return ctx;
}
