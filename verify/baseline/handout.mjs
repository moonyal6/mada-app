// What the patient handout page (/h/<token>) shows, read from its server HTML.
//
// The page is the only place the raw adherence rows (`exIdx`) surface, so the
// baseline records what a patient sees: the visible text, which exercises are
// ticked, the pain score selected today and the week strip's dots.
//
// Today's weekday and date change from run to run. The page's own
// formatting (components/patient/PatientHandout.tsx, lib/format.ts `fmtDate`)
// is mirrored here so they become <today> and <weekday:today-N>; every other
// date stays as it is.

const WEEKDAYS = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

/** @param {string} day YYYY-MM-DD @param {number} n */
function addDays(day, n) {
  const d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Mirrors `fmtDate()` in lib/format.ts. @param {string} day */
function fmtDate(day) {
  return new Date(day + "T00:00:00").toLocaleDateString("ar-SA-u-ca-gregory", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** @param {string} html */
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {unknown} html the raw response body
 * @param {{ today: string }} ctx
 */
export function handoutView(html, { today }) {
  if (typeof html !== "string") return html;
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html)
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");

  // Weekday names: today and the six days before it are exactly the strip.
  /** @type {Map<string, string>} */
  const weekday = new Map();
  for (let n = 0; n < 7; n++) {
    const name = WEEKDAYS[new Date(addDays(today, -n) + "T00:00:00Z").getUTCDay()];
    weekday.set(name, n ? `<weekday:today-${n}>` : "<weekday:today>");
  }
  const todayText = fmtDate(today);
  /** @param {string} s */
  const relative = (s) =>
    s.split(todayText).join("<today>").replace(/[؀-ۿ]+/g, (w) => weekday.get(w) ?? w);

  const lines = body
    .split(/<(?:\/div|\/p|\/h2|\/b|\/span|\/button|\/a|br\s*\/?)>/)
    .map(textOf)
    .filter(Boolean)
    .map(relative);

  const exercises = [...body.matchAll(/<div class="pt-ex">([\s\S]*?)<button class="pt-check( on)?"/g)].map(
    ([, ex, on]) => ({ exercise: textOf(ex.match(/<div class="ar">([\s\S]*?)<\/div>/)?.[1] ?? ""), ticked: !!on }),
  );
  const pain = body.match(/<div class="pt-pain">[\s\S]*?<button class="on">([^<]*)<\/button>/)?.[1] ?? null;
  const week = [...body.matchAll(/<div class="d( today)?"><b>([^<]*)<\/b><div class="dot ?([^"]*)"><\/div>/g)].map(
    ([, today, name, dot]) => ({ day: relative(name), today: !!today, dot: dot || "none" }),
  );

  return { lines, exercises, painToday: pain, week };
}
