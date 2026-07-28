import type { CaseKey } from "./data/cases";

export type { CaseKey };

/** A catalogue exercise (case library, AI suggestion, or manual entry). */
export type Exercise = {
  ar: string;
  en: string;
  desc: string;
};

/** An exercise that made it into the basket. */
export type SelectedExercise = Exercise & {
  url: string;
  source: "case" | "added";
};

export type Patient = {
  name: string;
  file: string;
  age: string;
  sex: string;
  caseKey: CaseKey;
  complaint: string;
};

export type DoctorOpinion = {
  dx: string;
  date: string;
  sessions: string;
  frequency: string;
  home: string;
  follow: string;
  pain: string;
  advice: string;
  planNotes: string;
};

export type GenMode = "direct" | "manual";

export type SessionState = {
  step: number;
  patient: Patient;
  dialogue: string;
  doctor: DoctorOpinion;
  selected: Record<string, SelectedExercise>;
  genMode: GenMode;
  report: string;
  sealed: boolean;
  sealDate: string;
  /**
   * Stands in for the MVP's `.report-draft.show` class. The draft panel stays
   * on screen once it has been revealed, even if the doctor clears the text —
   * keying it off `report !== ""` would make the panel vanish mid-edit.
   */
  draftVisible: boolean;
};
