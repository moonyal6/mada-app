import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decide } from "../.claude/hooks/guard.mjs";

// A throwaway project and home, so symlink cases are real and nothing touches
// the actual ~/.claude.
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "guard-")));
const projectDir = path.join(base, "project");
const home = path.join(base, "home");
mkdirSync(path.join(projectDir, ".claude", "hooks"), { recursive: true });
mkdirSync(path.join(projectDir, "lib"), { recursive: true });
mkdirSync(path.join(home, ".claude"), { recursive: true });
writeFileSync(path.join(projectDir, ".claude", "settings.json"), "{}");
symlinkSync(path.join(projectDir, ".claude"), path.join(projectDir, "lib", "cfg"));
symlinkSync(path.join(projectDir, ".claude", "settings.json"), path.join(projectDir, "settings-link.json"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ctx = { projectDir, home };
const run = (tool: string, input: Record<string, unknown>) => decide(tool, input, ctx).allow;

const denied: [string, Record<string, unknown>][] = [
  ["Read", { file_path: ".env" }],
  ["Read", { file_path: ".env.local" }],
  ["Read", { file_path: "./lib/../.env" }],
  ["Read", { file_path: path.join(projectDir, ".ENV") }],
  ["Grep", { pattern: "x", path: ".env" }],
  ["Grep", { pattern: "x", glob: ".env*" }],
  ["Write", { file_path: ".env", content: "" }],
  ["Write", { file_path: ".claude/settings.json", content: "" }],
  ["Write", { file_path: ".claude/settings.local.json", content: "" }],
  ["Edit", { file_path: ".claude/hooks/guard.mjs", old_string: "a", new_string: "b" }],
  ["Write", { file_path: "~/.claude/settings.json", content: "" }],
  ["Write", { file_path: ".CLAUDE/settings.local.json", content: "" }],
  ["Write", { file_path: "lib/cfg/settings.local.json", content: "" }],
  ["Write", { file_path: "settings-link.json", content: "" }],
  ["MultiEdit", { file_path: ".claude/settings.json", edits: [] }],
  ["NotebookEdit", { notebook_path: ".claude/x.ipynb", new_source: "" }],
  ["Bash", { command: "cat .env" }],
  ["Bash", { command: "source .env" }],
  ["Bash", { command: "ls .claude/" }],
  ["Bash", { command: "cat ~/.claude/settings.json" }],
  ["Bash", { command: "cat $HOME/.claude/settings.json" }],
  ["Bash", { command: `python3 -c "open('.claude/settings.local.json','w').write('{}')"` }],
  ["Bash", { command: `echo '{"disableAllHooks":true}' > .claude/settings.local.json` }],
  ["Bash", { command: "echo x>.env.local" }],
  ["Bash", { command: "echo $(cat .env)" }],
  ["Bash", { command: "cat .env.example .env" }],
];

const allowed: [string, Record<string, unknown>][] = [
  ["Read", { file_path: ".env.example" }],
  ["Read", { file_path: ".claude/settings.json" }],
  ["Grep", { pattern: "x", glob: "*.ts" }],
  ["Write", { file_path: ".env.example", content: "" }],
  ["Write", { file_path: "tests/smoke.test.ts", content: "" }],
  ["Write", { file_path: "migrations/001.sql", content: "" }],
  ["Write", { file_path: "verify/e2e.mjs", content: "" }],
  ["Write", { file_path: "lib/x.ts", content: "" }],
  ["Write", { file_path: "~/.claude/projects/x/memory/note.md", content: "" }],
  ["Bash", { command: "npm test" }],
  ["Bash", { command: "npm run dev" }],
  ["Bash", { command: "cat .env.example" }],
  ["Bash", { command: "grep -r process.env lib/" }],
  ["Bash", { command: "npm ls dotenv" }],
  ["Bash", { command: "git diff tests/" }],
  ["Bash", { command: "cat CLAUDE.md" }],
];

describe("guard decide()", () => {
  it.each(denied)("denies %s %j", (tool, input) => {
    const result = decide(tool, input, ctx);
    expect(result.allow).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it.each(allowed)("allows %s %j", (tool, input) => {
    expect(run(tool, input)).toBe(true);
  });

  it("denies malformed file-tool and Bash input", () => {
    expect(run("Read", {})).toBe(false);
    expect(run("Bash", {})).toBe(false);
  });
});
