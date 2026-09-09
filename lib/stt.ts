/**
 * The device's transcription-provider choice. Only the *key* the server
 * offered in `GET /api/stt` (or "auto") is stored — the browser never learns
 * anything about a provider beyond its name and whether it is available.
 * Lives in a cookie so the server reads it at segment upload time; that is
 * also what makes it per device and what lets a switch take effect on the
 * very next segment of a recording already in progress.
 */
export const STT_COOKIE = "mada_stt";
export const STT_AUTO = "auto";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Lower-case key, letters only; "" when nothing usable. */
export function normalizeSttChoice(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const v = raw.trim().toLowerCase();
  return /^[a-z_]{1,20}$/.test(v) ? v : "";
}

export function readSttCookie(): string {
  if (typeof document === "undefined") return "";
  const hit = document.cookie
    .split("; ")
    .find((c) => c.startsWith(STT_COOKIE + "="));
  return normalizeSttChoice(hit?.slice(STT_COOKIE.length + 1));
}

/**
 * "auto" is stored as an explicit choice (it overrides a pinned `MADA_STT`
 * default); "" clears the cookie so the server default applies again.
 */
export function writeSttCookie(key: string): void {
  if (typeof document === "undefined") return;
  const v = normalizeSttChoice(key);
  document.cookie = v
    ? `${STT_COOKIE}=${v}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
    : `${STT_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
}
