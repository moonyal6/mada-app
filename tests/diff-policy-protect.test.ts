import { describe, expect, it } from "vitest";
import { findProtectedChanges, parseNameStatus } from "../scripts/diff-policy.mjs";

// Rules A and B from #13 live in their own file: editing
// tests/diff-policy.test.ts alongside the script would trip rule A.

type Change = { status: string; path: string; oldPath?: string };
const m = (path: string): Change => ({ status: "M", path });
const a = (path: string): Change => ({ status: "A", path });
const d = (path: string): Change => ({ status: "D", path });
const r = (oldPath: string, path: string): Change => ({ status: "R", path, oldPath });

const check = (changes: Change[], labels: string[] = []) => findProtectedChanges(changes, labels);

describe("rule A: existing tests changed alongside code", () => {
  it.each([
    ["modified", [m("tests/smoke.test.ts"), m("lib/arabic.ts")], "tests/smoke.test.ts"],
    ["deleted", [d("tests/smoke.test.ts"), m("lib/arabic.ts")], "tests/smoke.test.ts"],
    ["renamed away", [r("tests/smoke.test.ts", "tests/old/smoke.test.ts"), m("lib/arabic.ts")], "tests/smoke.test.ts"],
    ["colocated *.test.ts", [m("lib/server/db.test.ts"), m("lib/server/db.ts")], "lib/server/db.test.ts"],
    ["verify script", [m("verify/stt.mjs"), m("app/api/x/route.ts")], "verify/stt.mjs"],
    ["vitest config", [m("vitest.config.mts"), m("scripts/diff-policy.mjs")], "vitest.config.mts"],
  ])("flags a %s test and names it", (_name, changes, file) => {
    const v = check(changes as Change[]);
    expect(v).toEqual([expect.objectContaining({ file, rule: expect.stringMatching(/existing test/) })]);
    expect(v[0].line).toBeUndefined();
  });

  it("names every existing test it flags", () => {
    const v = check([m("tests/a.test.ts"), d("tests/b.test.ts"), m("lib/x.ts")]);
    expect(v.map((x) => x.file)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });

  it("counts a deleted or renamed code file as a code change", () => {
    expect(check([m("tests/smoke.test.ts"), d("lib/old.ts")])).toHaveLength(1);
    expect(check([m("tests/smoke.test.ts"), r("lib/a.ts", "lib/b.ts")])).toHaveLength(1);
  });

  it("allows a new test next to code", () => {
    expect(check([a("tests/new.test.ts"), m("lib/arabic.ts"), a("verify/new.mjs")])).toEqual([]);
  });

  it("allows a test-only PR", () => {
    expect(check([m("tests/smoke.test.ts"), d("verify/soak.mjs"), m("vitest.config.mts")])).toEqual([]);
  });

  it("allows an existing test edited next to non-code files only", () => {
    expect(check([m("tests/smoke.test.ts"), m("notes/lessons.md"), m(".github/workflows/ci.yml"), m("package.json")])).toEqual([]);
  });
});

describe("rule B: migrations need the label", () => {
  it.each([
    ["added", [a("migrations/0001_init.sql")], "migrations/0001_init.sql"],
    ["modified", [m("migrations/0001_init.sql")], "migrations/0001_init.sql"],
    ["deleted", [d("migrations/0001_init.sql")], "migrations/0001_init.sql"],
    ["renamed out", [r("migrations/0001_init.sql", "old/0001_init.sql")], "migrations/0001_init.sql"],
  ])("flags a %s migration without the label", (_name, changes, file) => {
    expect(check(changes as Change[])).toEqual([
      expect.objectContaining({ file, rule: expect.stringMatching(/"migration" label/) }),
    ]);
  });

  it("is clean with the label", () => {
    expect(check([a("migrations/0001_init.sql")], ["review:light", "migration"])).toEqual([]);
  });

  it("does not let the label excuse rule A", () => {
    const v = check([m("tests/smoke.test.ts"), m("lib/arabic.ts")], ["migration"]);
    expect(v).toHaveLength(1);
  });

  it("does not cover lib/server/db.ts", () => {
    expect(check([m("lib/server/db.ts")])).toEqual([]);
  });
});

describe("parseNameStatus", () => {
  it("reads -z output with renames, deletes and odd paths", () => {
    const text = ["R100", "tests/a.test.ts", "tests/b.test.ts", "D", "lib/old.ts", "M", "app/عربي ملف.tsx", ""].join("\0");
    expect(parseNameStatus(text)).toEqual([
      { status: "R", path: "tests/b.test.ts", oldPath: "tests/a.test.ts" },
      { status: "D", path: "lib/old.ts" },
      { status: "M", path: "app/عربي ملف.tsx" },
    ]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseNameStatus("")).toEqual([]);
  });
});
