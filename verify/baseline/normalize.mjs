// Baseline normalisation and comparison (issue #7).
//
// A response body is normalised before it is recorded and before it is
// compared, so only the parts a run generates are replaced:
//   - generated IDs (lib/server/db.ts `uid()`: p/a/i/n/s/r + 12 hex) become
//     <p#1>, <p#2>… numbered by first appearance across the whole run, so a
//     reference to a record still has to point at the same record;
//   - the handout token becomes <token#1>…, numbered the same way;
//   - ISO timestamps become <ts>; null stays null;
//   - the clinic's current date becomes <today>.
// Seed IDs (p1, a1…) and everything else are left exactly as they are.
//
// The comparison ignores key order and nothing else: types, key names, null
// vs missing and array order all count.

const GENERATED_ID = /^[painsr][0-9a-f]{12}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TOKEN_KEY = "handoutToken";

/**
 * One normalizer per run: the alias numbering carries from step to step.
 * @param {{ today: string }} options `today` is the clinic date, YYYY-MM-DD.
 */
export function createNormalizer({ today }) {
  /** @type {Map<string, string>} raw value → alias */
  const aliases = new Map();
  /** @type {Map<string, number>} alias kind → last number used */
  const counters = new Map();

  /** @param {string} value @param {string} kind */
  function alias(value, kind) {
    let a = aliases.get(value);
    if (!a) {
      const n = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, n);
      a = `<${kind}#${n}>`;
      aliases.set(value, a);
    }
    return a;
  }

  /**
   * Gives every new ID and token in `value` its number. Keys are walked in
   * sorted order so the numbering doesn't depend on the order the server
   * happened to serialise them in.
   * @param {unknown} value
   * @param {string | null} key
   */
  function register(value, key) {
    if (typeof value === "string") {
      if (key === TOKEN_KEY) alias(value, "token");
      else if (GENERATED_ID.test(value)) alias(value, value[0]);
    } else if (Array.isArray(value)) {
      for (const v of value) register(v, null);
    } else if (value && typeof value === "object") {
      for (const k of Object.keys(value).sort()) register(/** @type {Record<string, unknown>} */ (value)[k], k);
    }
  }

  /** @param {unknown} value @returns {unknown} */
  function replace(value) {
    if (typeof value === "string") {
      const a = aliases.get(value);
      if (a) return a;
      if (ISO_TIMESTAMP.test(value)) return "<ts>";
      if (value === today) return "<today>";
      return value;
    }
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    }
    return value;
  }

  return {
    /** @param {unknown} body @returns {unknown} */
    normalize(body) {
      register(body, null);
      return replace(body);
    },
  };
}

/** @typedef {{ path: string, expected: unknown, actual: unknown }} Difference */

/**
 * Every difference between two JSON values, each with its JSON path.
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} [path]
 * @returns {Difference[]}
 */
export function diff(expected, actual, path = "$") {
  const ek = kind(expected);
  if (ek !== kind(actual)) return [{ path, expected, actual }];

  if (ek === "array") {
    const e = /** @type {unknown[]} */ (expected);
    const a = /** @type {unknown[]} */ (actual);
    const out = [];
    for (let i = 0; i < Math.max(e.length, a.length); i++) {
      out.push(...diff(e[i], a[i], `${path}[${i}]`));
    }
    return out;
  }

  if (ek === "object") {
    const e = /** @type {Record<string, unknown>} */ (expected);
    const a = /** @type {Record<string, unknown>} */ (actual);
    const keys = [...new Set([...Object.keys(e), ...Object.keys(a)])].sort();
    return keys.flatMap((k) => {
      const at = pathOf(path, k);
      if (!Object.hasOwn(a, k)) return [{ path: at, expected: e[k], actual: undefined }];
      if (!Object.hasOwn(e, k)) return [{ path: at, expected: undefined, actual: a[k] }];
      return diff(e[k], a[k], at);
    });
  }

  return expected === actual ? [] : [{ path, expected, actual }];
}

/** @param {unknown} v */
function kind(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** @param {string} parent @param {string} key */
function pathOf(parent, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}
