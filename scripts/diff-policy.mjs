// CI diff policy: fails a PR that silences a check instead of passing it.
//
// Flags, on lines the PR *adds* to code files: TypeScript suppression
// comments, eslint disable comments, and test skip/focus modifiers. Also
// flags a tsconfig.json that this PR made less strict. There is no escape
// hatch — a legitimate suppression is merged by a human over the red check.
//
//   node scripts/diff-policy.mjs origin/main
//
// Exit 0: clean. Exit 1: violations. Exit 2: could not run (e.g. the
// merge-base is unreachable in a shallow clone) — never a silent pass.
//
// This file and its tests must not contain the banned tokens literally, or
// the PR that touches them fails its own check; hence the split patterns.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CODE_EXT = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

/** Each pattern reports the text it matched, so the message names the token. */
const BANNED = [
  { kind: "TypeScript suppression", re: /@ts-(?:ignore|expect-error|nocheck)\b/ },
  { kind: "eslint suppression", re: new RegExp("eslint" + "-disable(?:-next-line|-line)?") },
  {
    kind: "test skip/focus modifier",
    re: /(?<![\w$.])(?:describe|it|test|suite|bench)(?:\.\w+)*?\.(?:skip|only)(?:If)?\b/,
  },
];

const STRICT_FAMILY = [
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
];

/**
 * @typedef {{ file: string, line: number, rule: string }} Violation
 */

/**
 * Pure policy check. `diffText` is unified `git diff` output; the tsconfigs are
 * the raw file text at the merge-base and at HEAD (null when absent).
 * @param {string} diffText
 * @param {string | null} baseTsconfig
 * @param {string | null} headTsconfig
 * @returns {Violation[]}
 */
export function findViolations(diffText, baseTsconfig, headTsconfig) {
  return [...scanAddedLines(diffText), ...checkTsconfig(baseTsconfig, headTsconfig)];
}

/** @param {string} diffText @returns {Violation[]} */
function scanAddedLines(diffText) {
  /** @type {Violation[]} */
  const out = [];
  let file = null;
  let inHunk = false;
  let lineNo = 0;

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("+++ ")) file = parsePath(raw.slice(4));
      else if (raw.startsWith("@@")) inHunk = startHunk(raw);
      if (inHunk) lineNo = hunkStart(raw);
      continue;
    }
    if (raw.startsWith("@@")) {
      lineNo = hunkStart(raw);
      continue;
    }
    const tag = raw[0];
    if (tag === "+") {
      if (file && CODE_EXT.test(file)) {
        for (const { kind, re } of BANNED) {
          const m = raw.slice(1).match(re);
          if (m) out.push({ file, line: lineNo, rule: `${kind}: ${m[0]}` });
        }
      }
      lineNo++;
    } else if (tag === " ") {
      lineNo++;
    }
    // "-" lines and "\ No newline at end of file" don't advance the new side.
  }
  return out;
}

/** @param {string} raw */
function startHunk(raw) {
  return /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(raw);
}

/** @param {string} raw */
function hunkStart(raw) {
  const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** "b/path", a quoted "b/pa th", or /dev/null for a deletion. */
function parsePath(spec) {
  let p = spec.trimEnd();
  if (p === "/dev/null") return null;
  if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p);
  return p.startsWith("b/") ? p.slice(2) : p;
}

/**
 * Flags each loosening that holds at HEAD but did not hold at the merge-base,
 * so a PR is judged on what it changed.
 * @param {string | null} baseText @param {string | null} headText
 * @returns {Violation[]}
 */
function checkTsconfig(baseText, headText) {
  const file = "tsconfig.json";
  if (baseText === headText) return [];

  const head = parseOptions(headText);
  if (!head.ok) {
    return [{ file, line: 1, rule: `tsconfig.json could not be parsed: ${head.error}` }];
  }
  const base = parseOptions(baseText);
  const baseOpts = base.ok ? base.options : {};

  /** @type {Violation[]} */
  const out = [];
  if (head.options.strict !== true && baseOpts.strict === true) {
    const rule =
      "strict" in head.options
        ? `compilerOptions.strict is ${JSON.stringify(head.options.strict)}, not true`
        : "compilerOptions.strict was removed";
    out.push({ file, line: keyLine(headText, "strict"), rule });
  }
  for (const flag of STRICT_FAMILY) {
    if (head.options[flag] === false && baseOpts[flag] !== false) {
      out.push({ file, line: keyLine(headText, flag), rule: `compilerOptions.${flag} set to false` });
    }
  }
  return out;
}

/** @param {string | null} text */
function parseOptions(text) {
  if (text == null) return { ok: true, options: {} };
  try {
    const json = JSON.parse(stripJsonc(text));
    return { ok: true, options: (json && json.compilerOptions) || {} };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** tsconfig is JSONC: drop comments and trailing commas, leaving strings intact. */
function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const skipped = text.slice(i, end === -1 ? text.length : end + 2);
      out += skipped.replace(/[^\n]/g, " ");
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** 1-based line of `"key"` in the text, for the annotation; 1 if absent. */
function keyLine(text, key) {
  if (!text) return 1;
  const idx = text.split("\n").findIndex((l) => l.includes(`"${key}"`));
  return idx === -1 ? 1 : idx + 1;
}

// ---- CLI ------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function showOrNull(rev, path) {
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** GitHub workflow-command escaping. */
const escData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("usage: node scripts/diff-policy.mjs <base-ref>   (e.g. origin/main)");
    process.exit(2);
  }

  let mergeBase;
  try {
    mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    let shallow = "";
    try {
      shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true"
        ? " The clone is shallow; check out with fetch-depth: 0."
        : "";
    } catch {
      // No hint; the merge-base error below still fails the run.
    }
    const detail = String(e?.stderr ?? "").trim();
    const msg = `diff-policy: cannot resolve the merge-base of ${baseRef} and HEAD.${shallow}${detail ? ` (${detail})` : ""}`;
    console.log(`::error::${escData(msg)}`);
    console.error(msg);
    process.exit(2);
  }

  const diff = git([
    "-c", "core.quotePath=true",
    "diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/",
    mergeBase, "HEAD",
  ]);
  const violations = findViolations(
    diff,
    showOrNull(mergeBase, "tsconfig.json"),
    showOrNull("HEAD", "tsconfig.json"),
  );

  console.log(`diff-policy: ${baseRef} (merge-base ${mergeBase.slice(0, 12)}) → HEAD`);
  for (const v of violations) {
    console.log(`::error file=${escProp(v.file)},line=${v.line}::${escData(v.rule)}`);
    console.log(`  ${v.file}:${v.line}  ${v.rule}`);
  }
  if (violations.length) {
    console.log(`diff-policy: ${violations.length} violation(s). There is no override; a human decides whether to merge on red.`);
    process.exit(1);
  }
  console.log("diff-policy: clean.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
