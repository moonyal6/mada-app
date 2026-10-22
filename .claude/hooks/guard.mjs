#!/usr/bin/env node
// PreToolUse guard: keeps agents out of `.env` and out of Claude Code's own
// settings. Spec: issue #3. Exit 0 allows, exit 2 denies (reason on stderr).
// Fails closed: bad input or any error exits 2. There is deliberately no flag,
// env var or marker file that changes a decision.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const allow = () => ({ allow: true, reason: null });
const deny = (reason) => ({ allow: false, reason });

// `.env` or `.env.<suffix>`, except `.env.example`. Compared lower-case.
function isEnvName(name) {
  const n = name.toLowerCase();
  return n === ".env" || (n.startsWith(".env.") && n !== ".env.example");
}

// Realpath of the longest existing prefix, with the rest appended, so a path
// that doesn't exist yet (a new file) still has its symlinked parents followed.
function realish(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function expandHome(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

// Every form of the path worth matching: as resolved, and with symlinks
// followed. Lower-cased because APFS is case-insensitive.
function forms(rawPath, { projectDir, home }) {
  const abs = path.resolve(projectDir, expandHome(rawPath, home));
  return [...new Set([abs, realish(abs)])].map((p) => p.toLowerCase());
}

function roots({ projectDir, home }) {
  const r = (p) => realish(path.resolve(p)).toLowerCase();
  return {
    project: r(projectDir),
    home: r(home),
    projectRaw: path.resolve(projectDir).toLowerCase(),
    homeRaw: path.resolve(home).toLowerCase(),
  };
}

function within(p, dir) {
  return p === dir || p.startsWith(dir + path.sep);
}

function envReason(p) {
  return isEnvName(path.basename(p)) ? `${path.basename(p)} holds secrets; agents may not access it` : null;
}

function claudeWriteReason(p, ctx) {
  const { project, home, projectRaw, homeRaw } = roots(ctx);
  for (const dir of new Set([project, projectRaw])) {
    if (!within(p, dir)) continue;
    const segments = path.relative(dir, p).split(path.sep);
    if (segments.includes(".claude")) return ".claude/ is hook-protected; only a human may change it";
  }
  for (const h of new Set([home, homeRaw])) {
    const dir = path.join(h, ".claude");
    if (path.dirname(p) === dir && /^settings.*\.json$/.test(path.basename(p))) {
      return "~/.claude settings are hook-protected; only a human may change them";
    }
  }
  return null;
}

// Grep's `glob` filters file names; deny one that would select an env file.
function globTargetsEnv(glob) {
  const last = glob.split("/").pop() ?? "";
  const source = last
    .replace(/[.+^$()|\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{([^}]*)\}/g, (_, alts) => `(?:${alts.split(",").join("|")})`);
  let re;
  try {
    re = new RegExp(`^${source}$`, "i");
  } catch {
    return true; // can't tell what it matches: fail closed
  }
  return [".env", ".env.local"].some((n) => re.test(n));
}

// Bash: deny any command that names a guarded path as a path segment.
const L = String.raw`(?:^|[\s/'"=:<>|&;()\x60{,])`;
const R = String.raw`(?=$|[\s/'";<>|&()\x60},])`;
const BASH_ENV = new RegExp(`${L}\\.env((?:\\.[\\w.-]+)?)${R}`, "gi");
const BASH_CLAUDE = new RegExp(`${L}\\.claude${R}`, "i");

function bashReason(command) {
  for (const m of command.matchAll(BASH_ENV)) {
    if (m[1].toLowerCase() !== ".example") return "command names a .env file, which holds secrets";
  }
  if (BASH_CLAUDE.test(command)) return "command names .claude/, which is hook-protected; use the Read tool to read it";
  return null;
}

function pathOf(toolName, input) {
  return toolName === "NotebookEdit" ? input.notebook_path : input.file_path;
}

export function decide(toolName, toolInput, ctx = {}) {
  const c = {
    projectDir: ctx.projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    home: ctx.home ?? homedir(),
  };
  const input = toolInput ?? {};

  if (toolName === "Bash") {
    if (typeof input.command !== "string") return deny("Bash input has no command string");
    const reason = bashReason(input.command);
    return reason ? deny(reason) : allow();
  }

  if (toolName === "Grep") {
    if (input.path != null) {
      if (typeof input.path !== "string") return deny("Grep path is not a string");
      for (const p of forms(input.path, c)) {
        const reason = envReason(p);
        if (reason) return deny(reason);
      }
    }
    if (input.glob != null) {
      if (typeof input.glob !== "string" || globTargetsEnv(input.glob)) {
        return deny("Grep glob targets a .env file, which holds secrets");
      }
    }
    return allow();
  }

  if (toolName === "Read" || WRITE_TOOLS.has(toolName)) {
    const raw = pathOf(toolName, input);
    if (typeof raw !== "string" || raw === "") return deny(`${toolName} input has no path`);
    for (const p of forms(raw, c)) {
      const reason = envReason(p) ?? (WRITE_TOOLS.has(toolName) ? claudeWriteReason(p, c) : null);
      if (reason) return deny(reason);
    }
    return allow();
  }

  return allow();
}

function isMain() {
  if (!process.argv[1]) return false;
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
}

function main() {
  const fail = (reason) => {
    process.stderr.write(`guard: ${reason}\n`);
    process.exit(2);
  };
  process.on("uncaughtException", (e) => fail(`internal error, denying: ${e?.message ?? e}`));

  const chunks = [];
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("end", () => {
    let event;
    try {
      event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return fail("hook input is not valid JSON, denying");
    }
    if (!event || typeof event !== "object") return fail("hook input is not an object, denying");
    const result = decide(event.tool_name, event.tool_input);
    if (result.allow) process.exit(0);
    fail(`denied: ${result.reason}`);
  });
}

// A crash here would exit 1, which Claude Code treats as "carry on".
let runAsHook = false;
try {
  runAsHook = isMain();
} catch (e) {
  process.stderr.write(`guard: cannot locate itself, denying: ${e?.message ?? e}\n`);
  process.exit(2);
}
if (runAsHook) main();
