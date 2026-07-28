"use client";

import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import { STEPS } from "./data/steps";
import type { CaseKey } from "./data/cases";
import type {
  DoctorOpinion,
  Exercise,
  GenMode,
  Patient,
  SelectedExercise,
  SessionState,
} from "./types";

/* The reducer is pure and in-memory, exactly as in the MVP. Persistence wraps
   around it in lib/persistence.tsx, which watches state and writes through to
   localStorage — restore comes back in via the `replace` action. */

export const initialSessionState: SessionState = {
  step: 0,
  patient: {
    name: "",
    file: "",
    age: "",
    sex: "ذكر",
    caseKey: "back",
    complaint: "",
  },
  dialogue: "",
  doctor: {
    dx: "",
    date: "",
    sessions: "",
    frequency: "",
    home: "",
    follow: "",
    pain: "",
    advice: "",
    planNotes: "",
  },
  selected: {},
  genMode: "direct",
  report: "",
  sealed: false,
  sealDate: "",
  draftVisible: false,
};

export type SessionAction =
  | { type: "goto"; step: number }
  | {
      type: "patientField";
      field: Exclude<keyof Patient, "caseKey">;
      value: string;
    }
  | { type: "caseKey"; value: CaseKey }
  | { type: "dialogue"; value: string }
  | { type: "appendDialogue"; line: string }
  | { type: "doctorField"; field: keyof DoctorOpinion; value: string }
  | { type: "toggleCaseExercise"; id: string; exercise: SelectedExercise }
  | { type: "addExercise"; exercise: Exercise; url?: string }
  | { type: "removeExercise"; id: string }
  | { type: "exerciseUrl"; id: string; url: string }
  | { type: "genMode"; value: GenMode }
  | { type: "reportText"; value: string }
  | { type: "showDraft"; text: string; sealed: boolean }
  | { type: "seal"; date: string }
  /** Swap in a whole session — restore from storage, resume, or new visit. */
  | { type: "replace"; state: SessionState };

/** Mirrors the MVP's monotonic addCounter, derived from state so the reducer
 *  stays pure. Uniqueness among live keys is all the ids are used for. */
function nextAddId(selected: Record<string, SelectedExercise>): string {
  let max = 0;
  for (const key of Object.keys(selected)) {
    const match = /^add-(\d+)$/.exec(key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `add-${max + 1}`;
}

export function sessionReducer(
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "goto": {
      if (action.step < 0 || action.step > STEPS.length - 1) return state;
      return { ...state, step: action.step };
    }
    case "patientField":
      return {
        ...state,
        patient: { ...state.patient, [action.field]: action.value },
      };
    case "caseKey": {
      // Changing the case drops the exercises that came from the old case
      // library; anything added by hand or via search stays in the basket.
      const selected: Record<string, SelectedExercise> = {};
      for (const [id, ex] of Object.entries(state.selected)) {
        if (ex.source !== "case") selected[id] = ex;
      }
      return {
        ...state,
        patient: { ...state.patient, caseKey: action.value },
        selected,
      };
    }
    case "dialogue":
      return { ...state, dialogue: action.value };
    case "appendDialogue":
      return {
        ...state,
        dialogue: (state.dialogue ? state.dialogue + "\n" : "") + action.line,
      };
    case "doctorField":
      return {
        ...state,
        doctor: { ...state.doctor, [action.field]: action.value },
      };
    case "toggleCaseExercise": {
      const selected = { ...state.selected };
      if (selected[action.id]) delete selected[action.id];
      else selected[action.id] = action.exercise;
      return { ...state, selected };
    }
    case "addExercise": {
      const id = nextAddId(state.selected);
      const { ar, en, desc } = action.exercise;
      return {
        ...state,
        selected: {
          ...state.selected,
          [id]: {
            ar,
            en: en || "",
            desc: desc || "",
            url: action.url || `https://mada.app/ex/custom-${id}`,
            source: "added",
          },
        },
      };
    }
    case "removeExercise": {
      const selected = { ...state.selected };
      delete selected[action.id];
      return { ...state, selected };
    }
    case "exerciseUrl": {
      const current = state.selected[action.id];
      if (!current) return state;
      return {
        ...state,
        selected: {
          ...state.selected,
          [action.id]: { ...current, url: action.url },
        },
      };
    }
    case "genMode":
      return { ...state, genMode: action.value };
    case "reportText":
      return { ...state, report: action.value };
    case "showDraft":
      return {
        ...state,
        report: action.text,
        sealed: action.sealed,
        draftVisible: true,
      };
    case "seal":
      return { ...state, sealDate: action.date, sealed: true, draftVisible: true };
    case "replace":
      return action.state;
    default:
      return state;
  }
}

type SessionContextValue = {
  state: SessionState;
  dispatch: Dispatch<SessionAction>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
