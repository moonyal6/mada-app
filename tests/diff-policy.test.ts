import { describe, expect, it } from "vitest";
import { findViolations } from "../scripts/diff-policy.mjs";

// Banned tokens are built by concatenation: written literally, this file
// would fail the diff-policy check of the PR that adds it.
const TS_IGNORE = "@ts-" + "ignore";
const TS_EXPECT = "@ts-" + "expect-error";
const TS_NOCHECK = "@ts-" + "nocheck";
const ESL = "eslint-" + "disable";

/** A one-file diff: a hunk starting at new line 10 with the given body lines. */
function diff(file: string, body: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -10,3 +10,${body.length} @@`,
    ...body,
    "",
  ].join("\n");
}

const scan = (d: string) => findViolations(d, null, null);

describe("banned tokens on added lines", () => {
  const cases: [string, string][] = [
    ["ts ignore", `// ${TS_IGNORE}`],
    ["ts expect-error", `// ${TS_EXPECT}`],
    ["ts nocheck", `// ${TS_NOCHECK}`],
    ["eslint line comment", `// ${ESL} no-console`],
    ["eslint -line", `foo(); // ${ESL}-line no-console`],
    ["eslint -next-line", `// ${ESL}-next-line @next/next/no-img-element`],
    ["eslint block comment", `/* ${ESL} */`],
    ["eslint jsx comment", `{/* ${ESL}-next-line @next/next/no-img-element */}`],
    ["it focus", `it` + `.only("x", () => {});`],
    ["describe skip", `describe` + `.skip("x", () => {});`],
    ["test skipIf", `test` + `.skipIf(ci)("x", () => {});`],
    ["describe only.each", `describe` + `.only.each([1])("x", () => {});`],
    ["chained concurrent focus", `describe.concurrent` + `.only("x", () => {});`],
    ["suite skip", `suite` + `.skip("x", () => {});`],
    ["bench focus", `bench` + `.only("x", () => {});`],
  ];

  it.each(cases)("flags %s with file and line", (_name, code) => {
    const d = diff("lib/arabic.ts", [" const a = 1;", `+${code}`, " const b = 2;"]);
    const v = scan(d);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: "lib/arabic.ts", line: 11 });
  });

  it("counts line numbers across removed lines and multiple hunks", () => {
    const d = [
      "diff --git a/app/x.tsx b/app/x.tsx",
      "--- a/app/x.tsx",
      "+++ b/app/x.tsx",
      "@@ -1,3 +1,2 @@",
      " a",
      "-b",
      "-c",
      "+c2",
      "@@ -40,2 +39,3 @@",
      " d",
      `+// ${TS_IGNORE}`,
      " e",
      "",
    ].join("\n");
    expect(scan(d)).toEqual([expect.objectContaining({ file: "app/x.tsx", line: 40 })]);
  });

  it("scans every code extension", () => {
    for (const ext of ["ts", "tsx", "mts", "cts", "js", "mjs", "cjs"]) {
      expect(scan(diff(`a/f.${ext}`, [`+// ${TS_IGNORE}`]))).toHaveLength(1);
    }
  });

  it("names the right file in a multi-file diff", () => {
    const d = diff("notes/x.md", [`+${TS_IGNORE}`]) + diff("lib/y.ts", [`+// ${TS_NOCHECK}`]);
    expect(scan(d)).toEqual([expect.objectContaining({ file: "lib/y.ts", line: 10 })]);
  });
});

describe("not flagged", () => {
  it("ignores removed and context lines", () => {
    const d = diff("lib/arabic.ts", [
      `-// ${TS_IGNORE}`,
      ` // ${ESL}-next-line @next/next/no-img-element`,
      `-describe` + `.skip("x", () => {});`,
      "+const ok = 1;",
    ]);
    expect(scan(d)).toEqual([]);
  });

  it("ignores non-code files", () => {
    for (const file of ["notes/lessons.md", "docs/spec.txt", "package.json", ".github/workflows/ci.yml"]) {
      expect(scan(diff(file, [`+${TS_IGNORE} ${ESL} it` + `.only`]))).toEqual([]);
    }
  });

  it("ignores an unrelated .skip( method call", () => {
    const lines = [
      "+stream.skip(4);",
      "+const r = foo.skip(1);",
      "+testUtils.skip();",
      "+submit.skip();",
      "+this.it.skip();",
      "+const onlyIf = describeAll;",
    ];
    expect(scan(diff("lib/stream.ts", lines))).toEqual([]);
  });

  it("ignores a deleted file", () => {
    const d = [
      "diff --git a/lib/old.ts b/lib/old.ts",
      "deleted file mode 100644",
      "--- a/lib/old.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      `-// ${TS_IGNORE}`,
      "",
    ].join("\n");
    expect(scan(d)).toEqual([]);
  });
});

describe("tsconfig strictness", () => {
  const cfg = (opts: Record<string, unknown>) =>
    JSON.stringify({ compilerOptions: { target: "ES2017", ...opts }, include: ["**/*.ts"] }, null, 2);
  const base = cfg({ strict: true });
  const check = (head: string | null) => findViolations("", base, head);

  it("flags strict changed to false", () => {
    const v = check(cfg({ strict: false }));
    expect(v).toEqual([expect.objectContaining({ file: "tsconfig.json", line: 4 })]);
    expect(v[0].rule).toMatch(/strict/);
  });

  it("flags strict deleted", () => {
    expect(check(cfg({}))).toEqual([
      expect.objectContaining({ file: "tsconfig.json", rule: expect.stringMatching(/removed/) }),
    ]);
  });

  it("flags a strict-family flag added as false", () => {
    const v = check(cfg({ strict: true, strictNullChecks: false }));
    expect(v).toEqual([
      expect.objectContaining({ file: "tsconfig.json", line: 5, rule: expect.stringMatching(/strictNullChecks/) }),
    ]);
  });

  it("flags a deleted tsconfig", () => {
    expect(check(null)).toHaveLength(1);
  });

  it("reads JSONC (comments, trailing commas)", () => {
    const head = `{\n  // loosened\n  "compilerOptions": {\n    "strict": false, /* temp */\n  },\n}\n`;
    expect(check(head)).toEqual([expect.objectContaining({ line: 4 })]);
  });

  it("fails loudly on an unparseable tsconfig", () => {
    expect(check("{ nope")[0].rule).toMatch(/could not be parsed/);
  });

  it("does not flag an unrelated compilerOptions change", () => {
    expect(check(cfg({ strict: true, target: "ES2022", noUnusedLocals: true }))).toEqual([]);
  });

  it("does not flag a strict-family flag set to true", () => {
    expect(check(cfg({ strict: true, noImplicitAny: true }))).toEqual([]);
  });
});
