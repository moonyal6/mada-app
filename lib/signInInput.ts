/**
 * What a person types to sign in, brought to the form the database stores
 * (#45, D15 and D16). Pure: no server-only import, so the sign-in pages (#46)
 * can use the same rules.
 */

/** The login code's length. The only place it lives in app code. */
export const LOGIN_CODE_DIGITS = 8;

/** The longest input looked at, before anything is removed. */
const MAX_INPUT = 320;
/** The longest email, after invisible marks and surrounding space are removed. */
const MAX_EMAIL = 254;

/**
 * Invisible format characters a phone keyboard or a copy from right-to-left
 * text can carry: U+061C, U+200B to U+200F, U+202A to U+202E, U+2060,
 * U+2066 to U+2069, U+FEFF.
 */
const INVISIBLE = /[؜​-‏‪-‮⁠⁦-⁩﻿]/g;

/** No `i` flag: a look-alike letter that lower-cases to ASCII is refused. */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
/** Full international form; no country code is guessed. */
const PHONE = /^\+[1-9][0-9]{7,14}$/;
/** Separators a person may type inside a phone number: space, U+00A0, `-`, `(`, `)`. */
const PHONE_SEPARATORS = /[  \-()]/g;
const CODE = new RegExp(`^[0-9]{${LOGIN_CODE_DIGITS}}$`);

/** Arabic-Indic (U+0660 to U+0669) and Extended Arabic-Indic (U+06F0 to U+06F9) digits to ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/**
 * A phone in `+<country><number>` form, or an email, lower-cased. Null for
 * anything that can't be one of them.
 */
export function normalizeIdentifier(input: unknown): { kind: "phone" | "email"; value: string } | null {
  if (typeof input !== "string" || input.length > MAX_INPUT) return null;
  const s = input.replace(INVISIBLE, "").trim();
  if (s.includes("@")) {
    if (s.length > MAX_EMAIL || !EMAIL.test(s)) return null;
    return { kind: "email", value: s.toLowerCase() };
  }
  const phone = s.replace(PHONE_SEPARATORS, "");
  return PHONE.test(phone) ? { kind: "phone", value: phone } : null;
}

/**
 * The code as LOGIN_CODE_DIGITS ASCII digits, or null. Whitespace, invisible
 * marks and Arabic digits are accepted.
 */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = asciiDigits(input.replace(INVISIBLE, "").replace(/\s/g, ""));
  return CODE.test(s) ? s : null;
}
