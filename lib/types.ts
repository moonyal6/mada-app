import type { CaseKey } from "./data/cases";

export type { CaseKey };

/** A catalogue exercise (case library, AI suggestion, or manual entry). */
export type LibraryExercise = {
  id: string;
  ar: string;
  en: string;
  /** Placeholder wording — the clinical lead replaces this before the pilot. */
  desc: string;
  /** Real video URL the handout QR encodes. Empty = honest "no video" tile. */
  video: string;
  /** Illustration path under /public. Schematic placeholder, not clinical art. */
  image: string;
};

/** An exercise that made it into the session basket. */
export type SelectedExercise = {
  ar: string;
  en: string;
  desc: string;
  /** Video URL (QR target). Editable per-session by the therapist. */
  url: string;
  image?: string;
  source: "case" | "added";
};

export type Patient = {
  id: string;
  name: string;
  phone: string;
  fileNo: string;
  age: number | null;
  sex: string;
  caseKey: CaseKey;
  complaint: string;
  status: string;
  createdAt: string;
};

export type Appointment = {
  id: string;
  patientId: string;
  date: string;
  time: string;
  type: string;
  status: string;
};

export type InvoiceItem = { desc: string; amount: number };

export type Invoice = {
  id: string;
  patientId: string;
  date: string;
  items: InvoiceItem[];
  total: number;
  paid: boolean;
};

export type InventoryItem = {
  id: string;
  name: string;
  qty: number;
  min: number;
  unit: string;
};

export type SessionStatus = "draft" | "final";

export type ClinicalSession = {
  id: string;
  patientId: string;
  status: SessionStatus;
  /**
   * Who ran the session — stamped once at creation from the device's chosen
   * name. Empty for sessions that predate attribution (display falls back to
   * the configured clinic therapist).
   */
  therapistName: string;
  step: number;
  dialogue: string;
  assessment: string;
  dx: string;
  date: string;
  sessionsCount: string;
  frequency: string;
  home: string;
  follow: string;
  pain: string;
  advice: string;
  planNotes: string;
  selected: Record<string, SelectedExercise>;
  /** Model-proposed impressions, kept for review/audit. Never auto-applied. */
  suggestedDx: string[];
  report: string;
  sealed: boolean;
  sealDate: string;
  /** Unguessable token; /h/[token] is the patient's handout page. */
  handoutToken: string;
  /** Recording-consent timestamp; null until captured. */
  consentAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

/** The wizard-editable subset of a session (what autosave PUTs). */
export type SessionDraftPatch = Partial<
  Pick<
    ClinicalSession,
    | "step"
    | "dialogue"
    | "assessment"
    | "dx"
    | "date"
    | "sessionsCount"
    | "frequency"
    | "home"
    | "follow"
    | "pain"
    | "advice"
    | "planNotes"
    | "selected"
    | "suggestedDx"
    | "report"
    | "sealed"
    | "sealDate"
  >
>;

export type SegmentStatus = "uploaded" | "transcribing" | "done" | "failed";

export type SegmentInfo = {
  seq: number;
  status: SegmentStatus;
  text: string;
  /** Arabic, therapist-facing, when status === "failed". */
  error: string;
  /** Label of the provider that produced the text ("" until done, or when skipped). */
  provider: string;
  /** "silence" = not sent (no speech), "degenerate" = output dropped, "failover" = a later provider answered. */
  note: string;
};

export type RecordingInfo = {
  id: string;
  sessionId: string;
  startedAt: string;
  segments: SegmentInfo[];
};

/** Patient-logged adherence, summarised for the follow-up screen. */
export type AdherenceSummary = {
  /** 0–100, or null when there is nothing to measure yet. */
  pct: number | null;
  checked: number;
  slots: number;
  lastPain: number | null;
  lastLogAt: string | null;
};

export type SttProviderInfo = {
  /** Opaque key the browser hands back as its choice — never a secret. */
  key: string;
  label: string;
  available: boolean;
  /** Why not, in Arabic, when unavailable. */
  reason: string | null;
};

export type SttStatus = {
  ready: boolean;
  /** Human label of the first provider audio goes to, e.g. "OpenAI" or "خادم العيادة (Whisper محلي)". */
  providerLabel: string | null;
  reason: string | null;
  /** Every provider the server knows, configured or not, for the picker. */
  providers: SttProviderInfo[];
  /** This device's effective choice: "auto" or a provider key. */
  selected: string;
  /** What applies when the device has chosen nothing (MADA_STT or "auto"). */
  defaultChoice: string;
  /** Labels of the providers a segment may reach, in order (one when pinned). */
  chain: string[];
  /** True when no audio can leave the clinic machine under the current choice. */
  keepsAudioLocal: boolean;
};
