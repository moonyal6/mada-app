/**
 * Transcript hygiene — pure functions, no I/O, no provider knowledge.
 *
 * Whisper-family models fed a segment with little real speech do not return
 * nothing: they invent fluent text, usually in the wrong language and often
 * one phrase repeated to fill the window. Silence is caught before upload
 * (see audio.ts); what still comes back degenerate is caught here and dropped
 * with a note so the UI can say a segment was ignored rather than hiding it.
 */

/** Primes the model with the domain so the first words of a segment land in Arabic. */
export const DOMAIN_PROMPT =
  "حوار جلسة علاج طبيعي بين الأخصائي والمريض في عيادة سعودية: الشكوى، الألم في الظهر أو الرقبة أو الكتف أو الركبة، مدى الحركة، التمارين، عدد الجلسات، الإرشادات.";

/** Hosted models cap the prompt (~224 tokens for Whisper); keep the tail short. */
const TAIL_CHARS = 250;

/** Domain prompt plus the tail of the transcript so far (names/terms stay consistent). */
export function buildPrompt(tail: string | undefined): string {
  const t = (tail ?? "").replace(/\s+/g, " ").trim().slice(-TAIL_CHARS);
  return t ? `${DOMAIN_PROMPT} ${t}` : DOMAIN_PROMPT;
}

/**
 * Stock hallucinations Whisper learned from subtitle corpora. Any of these
 * inside a clinic dialogue is noise, never speech.
 */
const STOCK_PHRASES: RegExp[] = [
  /اشترك(?:وا)? (?:في|بـ?)? ?(?:ال)?قناة[^.،]*/g,
  /ترجمة نانسي قنقر/g,
  /شكر(?:اً|ا) (?:على|لـ?) ?(?:ال)?مشاهدة[^.،]*/g,
  /لا تنس(?:وا|ى)? (?:ال)?(?:اشتراك|إعجاب)[^.،]*/g,
  /subtitles? by [^.]*/gi,
  /thanks? (?:you )?for watching[^.]*/gi,
  /\[[A-Z_ ]+\]/g, // [BLANK_AUDIO], [MUSIC] markers from whisper.cpp
  /\((?:music|applause|silence|inaudible)\)/gi,
];

const DIACRITICS = /[ً-ْٰـ]/g;

/** Strip markers and stock phrases, collapse whitespace. */
export function cleanTranscript(raw: string): string {
  let t = raw ?? "";
  for (const re of STOCK_PHRASES) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").trim();
}

function words(text: string): string[] {
  return text
    .replace(DIACRITICS, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export type DegenerateReason = "repetition" | "non_arabic";

/**
 * Null when the text looks like real dialogue. Deliberately lenient on short
 * output (one or two words can legitimately be an answer) and on Latin
 * letters (exercise names are English); strict on repetition and on scripts
 * that have no business in a Saudi clinic.
 */
export function degenerateReason(text: string): DegenerateReason | null {
  const ws = words(text);
  if (!ws.length) return null;

  let arabic = 0;
  let latin = 0;
  let other = 0;
  for (const ch of ws.join("")) {
    if (/[؀-ۿݐ-ݿ]/.test(ch)) arabic += 1;
    else if (/[A-Za-z]/.test(ch)) latin += 1;
    else if (/\p{L}/u.test(ch)) other += 1;
  }
  const letters = arabic + latin + other;
  if (letters >= 3) {
    if (other > 0 && other >= arabic) return "non_arabic";
    if (arabic / letters < 0.4 && latin >= 12) return "non_arabic";
  }

  if (ws.length >= 5) {
    const unique = new Set(ws).size;
    if (unique / ws.length < 0.4) return "repetition";
    let run = 1;
    for (let i = 1; i < ws.length; i += 1) {
      run = ws[i] === ws[i - 1] ? run + 1 : 1;
      if (run >= 4) return "repetition";
    }
    if (ws.length >= 9) {
      // One trigram covering most of the segment ("ألم في الظهر ألم في الظهر …").
      const counts = new Map<string, number>();
      for (let i = 0; i + 2 < ws.length; i += 1) {
        const k = ws.slice(i, i + 3).join(" ");
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = Math.max(...counts.values());
      if (top >= 3 && (top * 3) / ws.length > 0.5) return "repetition";
    }
  }
  return null;
}
