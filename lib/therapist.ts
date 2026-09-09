import { CLINIC } from "./config";
import type { ClinicalSession } from "./types";

/**
 * Therapist attribution. Several physiotherapists share one workspace by
 * design (everyone sees every patient and session); the only thing recorded
 * per session is *who ran it*, so reports and handouts carry the right name.
 *
 * The current name lives in a device cookie (readable by the server on
 * session creation, and by the clinic layout for a flash-free sidebar) and
 * is stamped onto the row once, at creation. Sessions from before this
 * existed have an empty name and fall back to the clinic's configured one.
 */
export const THERAPIST_COOKIE = "mada_therapist";
/** localStorage key for the device's short, editable list of names. */
export const THERAPIST_LIST_KEY = "mada_therapists";
export const THERAPIST_MAX = 80;
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Trim, collapse whitespace, cap length. Empty means "none chosen". */
export function normalizeTherapist(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, THERAPIST_MAX);
}

/** The name a session should display — its own, or the config fallback. */
export function therapistOf(
  session: Pick<ClinicalSession, "therapistName"> | null | undefined,
): string {
  return session?.therapistName || CLINIC.therapist;
}

const TITLE_WORD =
  /^(د|أ|دكتور|دكتورة|الدكتور|الدكتورة|أخصائي|أخصائية|dr|prof|mr|mrs|ms)$/i;
const DIACRITICS = /[ً-ْٰـ]/g;

/**
 * Sidebar avatar initials: first letter of the first and last name, skipping
 * titles ("د.") and the Arabic definite article on surnames — so the clinic's
 * "د. عبدالرحمن التركي" still yields "عت".
 */
export function initialsOf(name: string): string {
  const words = name
    .replace(DIACRITICS, "")
    .replace(/[.,،]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !TITLE_WORD.test(w));
  if (!words.length) return "؟";
  const lead = (w: string) => {
    const bare = w.length > 3 && w.startsWith("ال") ? w.slice(2) : w;
    return bare.charAt(0).toUpperCase();
  };
  const first = lead(words[0]);
  return words.length > 1 ? first + lead(words[words.length - 1]) : first;
}

/* ─── Cookie access (client side) ─────────────────────────────────────── */

/** Decode the cookie's value — shared by the server route and the client. */
export function decodeTherapistCookie(value: string | undefined): string {
  if (!value) return "";
  try {
    return normalizeTherapist(decodeURIComponent(value));
  } catch {
    return "";
  }
}

export function readTherapistCookie(): string {
  if (typeof document === "undefined") return "";
  const hit = document.cookie
    .split("; ")
    .find((c) => c.startsWith(THERAPIST_COOKIE + "="));
  return decodeTherapistCookie(hit?.slice(THERAPIST_COOKIE.length + 1));
}

export function writeTherapistCookie(name: string): void {
  if (typeof document === "undefined") return;
  const v = normalizeTherapist(name);
  document.cookie = v
    ? `${THERAPIST_COOKIE}=${encodeURIComponent(v)}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
    : `${THERAPIST_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}

/* ─── The device's name list ──────────────────────────────────────────── */

export function readTherapistList(): string[] {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(THERAPIST_LIST_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      list = parsed.map(normalizeTherapist).filter(Boolean);
    }
  } catch {
    /* unreadable → start from the default */
  }
  if (!list.includes(CLINIC.therapist)) list.unshift(CLINIC.therapist);
  return Array.from(new Set(list));
}

export function writeTherapistList(list: string[]): void {
  try {
    localStorage.setItem(
      THERAPIST_LIST_KEY,
      JSON.stringify(Array.from(new Set(list.map(normalizeTherapist).filter(Boolean)))),
    );
  } catch {
    /* storage unavailable — the cookie still carries the choice */
  }
}
