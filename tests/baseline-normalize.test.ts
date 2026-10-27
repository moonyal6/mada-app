import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNormalizer, diff } from "../verify/baseline/normalize.mjs";
import { isLocalBase } from "../verify/baseline.mjs";

// Written before verify/baseline/normalize.mjs and verify/baseline.mjs exist
// (issue #7, 7a). The baseline is only worth having if normalisation can't
// hide a real change, so most cases here are "this must still be reported".
// Importing verify/baseline.mjs must not start the runner (same main() guard
// as scripts/diff-policy.mjs).

type Json = unknown;
type Row = Record<string, Json>;

/** Views of a response body for mutating it in a test. */
const obj = (v: Json) => v as Row;
const rows = (v: Json) => v as Row[];

/** Same shape as lib/server/db.ts `uid()`: prefix + 12 lowercase hex. */
const gid = (prefix: string) => prefix + randomUUID().replaceAll("-", "").slice(0, 12);
/** Same shape as lib/server/db.ts `newToken()`. */
const newToken = () => randomBytes(16).toString("base64url");
const stamp = (base: number, offsetMs: number) => new Date(base + offsetMs).toISOString();

const TODAY = "2026-10-27";

type World = { p: string; q: string; s: string; i: string; token: string; t0: number };

/** A fresh set of the values a run generates: random IDs, token, clock. */
function world(t0 = Date.UTC(2026, 9, 27, 9, 0, 0)): World {
  return { p: gid("p"), q: gid("p"), s: gid("s"), i: gid("i"), token: newToken(), t0 };
}

/** Response bodies of a short run, in step order, as the API would return them. */
function scenario(w: World, today: string): Json[] {
  return [
    // POST /api/patients (full)
    { id: w.p, name: "سارة العتيبي", fileNo: "1004", phone: "0500000000", createdAt: stamp(w.t0, 0) },
    // POST /api/patients (minimal)
    { id: w.q, name: "نورة", fileNo: "1005", phone: "", createdAt: stamp(w.t0, 40) },
    // POST /api/sessions
    {
      id: w.s,
      patientId: w.p,
      status: "draft",
      handoutToken: w.token,
      date: today,
      consentAt: null,
      createdAt: stamp(w.t0, 90),
      finishedAt: null,
    },
    // GET /api/invoices
    [
      { id: w.i, patientId: w.p, amount: 300, paid: false, date: today, createdAt: stamp(w.t0, 120) },
      { id: "i1", patientId: "p1", amount: 250, paid: true, date: "2026-10-20", createdAt: "2026-10-20T08:00:00.000Z" },
    ],
  ];
}

const PATIENT = 0;
const SESSION = 2;
const INVOICES = 3;

type Difference = { step: number; path: string; expected: Json; actual: Json };

/**
 * Record one run, replay another, and return every difference. Each run gets
 * its own normalizer, as `--record` and replay do.
 */
function compareRuns(recorded: Json[], replayed: Json[], days = { recorded: TODAY, replayed: TODAY }): Difference[] {
  const rec = createNormalizer({ today: days.recorded });
  const rep = createNormalizer({ today: days.replayed });
  const fixtures = recorded.map((body) => rec.normalize(body));
  const actuals = replayed.map((body) => rep.normalize(body));
  return fixtures.flatMap((fixture, step) =>
    diff(fixture, actuals[step]).map((d: { path: string; expected: Json; actual: Json }) => ({ step, ...d })),
  );
}

/** Replays a fresh world, changed by `mutate`, against a recorded one. */
function replayWith(mutate: (steps: Json[]) => void): Difference[] {
  const replayed = scenario(world(), TODAY);
  mutate(replayed);
  return compareRuns(scenario(world(), TODAY), replayed);
}

/** Every object's keys in reverse order, recursively. Values unchanged. */
function reverseKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reverseKeys(v)]),
    );
  }
  return value;
}

describe("a replay of the same behaviour is clean", () => {
  it("reports nothing when only the random parts of generated IDs and the token differ", () => {
    expect(compareRuns(scenario(world(), TODAY), scenario(world(), TODAY))).toEqual([]);
  });

  it("reports nothing when every timestamp differs", () => {
    const recorded = scenario(world(Date.UTC(2026, 9, 27, 9, 0, 0)), TODAY);
    const replayed = scenario(world(Date.UTC(2026, 9, 27, 13, 17, 42, 311)), TODAY);
    expect(compareRuns(recorded, replayed)).toEqual([]);
  });

  it("reports nothing when the run happens on a different clinic day", () => {
    const recorded = scenario(world(Date.UTC(2026, 9, 27, 9)), "2026-10-27");
    const replayed = scenario(world(Date.UTC(2026, 10, 3, 9)), "2026-11-03");
    expect(compareRuns(recorded, replayed, { recorded: "2026-10-27", replayed: "2026-11-03" })).toEqual([]);
  });

  it("reports nothing when only key order changes", () => {
    const recorded = scenario(world(), TODAY);
    const replayed = scenario(world(), TODAY).map(reverseKeys);
    expect(compareRuns(recorded, replayed)).toEqual([]);
  });

  it("numbers generated IDs the same way whatever the key order", () => {
    // Two new IDs with the same prefix in one object. If numbering followed
    // key order, reordering the keys (jsonb does) would swap <s#1> and <s#2>.
    const a = { first: { id: gid("s") }, second: { id: gid("s") } };
    const b = { second: { id: gid("s") }, first: { id: gid("s") } };
    expect(compareRuns([a], [b])).toEqual([]);
  });
});

describe("a real change is still reported, with its JSON path", () => {
  it('a number that becomes a string (300 → "300")', () => {
    const diffs = replayWith((steps) => {
      rows(steps[INVOICES])[0].amount = "300";
    });
    expect(diffs).toEqual([{ step: INVOICES, path: "$[0].amount", expected: 300, actual: "300" }]);
  });

  it("a key whose case changes (patientId → patientid)", () => {
    const diffs = replayWith((steps) => {
      const session = obj(steps[SESSION]);
      session.patientid = session.patientId;
      delete session.patientId;
    });
    expect(diffs.map((d) => [d.step, d.path])).toEqual(
      expect.arrayContaining([
        [SESSION, "$.patientId"],
        [SESSION, "$.patientid"],
      ]),
    );
    expect(diffs.every((d) => d.step === SESSION)).toBe(true);
  });

  it("two array items swapped", () => {
    const diffs = replayWith((steps) => {
      rows(steps[INVOICES]).reverse();
    });
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((d) => d.step === INVOICES)).toBe(true);
    expect(diffs.some((d) => d.path.startsWith("$[0]"))).toBe(true);
    expect(diffs.some((d) => d.path.startsWith("$[1]"))).toBe(true);
  });

  it("an extra key", () => {
    const diffs = replayWith((steps) => {
      obj(steps[PATIENT]).deletedAt = null;
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ step: PATIENT, path: "$.deletedAt" });
    expect(diffs[0].expected).toBeUndefined();
    expect(diffs[0].actual).toBeNull();
  });

  it("a missing key", () => {
    const diffs = replayWith((steps) => {
      delete obj(steps[PATIENT]).fileNo;
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ step: PATIENT, path: "$.fileNo", expected: "1004" });
    expect(diffs[0].actual).toBeUndefined();
  });

  it('null that becomes ""', () => {
    const diffs = replayWith((steps) => {
      obj(steps[SESSION]).consentAt = "";
    });
    expect(diffs).toEqual([{ step: SESSION, path: "$.consentAt", expected: null, actual: "" }]);
  });

  it("null that becomes missing", () => {
    const diffs = replayWith((steps) => {
      delete obj(steps[SESSION]).consentAt;
    });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ step: SESSION, path: "$.consentAt" });
    expect(diffs[0].expected).toBeNull();
    expect(diffs[0].actual).toBeUndefined();
  });

  it("a reference that points at the wrong generated ID", () => {
    // Recorded: the session belongs to the first patient created. Replayed:
    // to the second. Both are valid-looking IDs; only the link is wrong.
    const w = world();
    const replayed = scenario(w, TODAY);
    obj(replayed[SESSION]).patientId = w.q;
    const diffs = compareRuns(scenario(world(), TODAY), replayed);
    expect(diffs).toEqual([{ step: SESSION, path: "$.patientId", expected: "<p#1>", actual: "<p#2>" }]);
  });

  it("a reference that points at the wrong seed ID", () => {
    const diffs = replayWith((steps) => {
      rows(steps[INVOICES])[1].patientId = "p2";
    });
    expect(diffs).toEqual([{ step: INVOICES, path: "$[1].patientId", expected: "p1", actual: "p2" }]);
  });

  it("null that becomes a timestamp", () => {
    // Timestamps normalise to <ts>; null must not, or a consent recorded
    // where none was expected would pass.
    const diffs = replayWith((steps) => {
      obj(steps[SESSION]).consentAt = new Date().toISOString();
    });
    expect(diffs).toEqual([{ step: SESSION, path: "$.consentAt", expected: null, actual: "<ts>" }]);
  });

  it("a date that isn't today", () => {
    const diffs = replayWith((steps) => {
      rows(steps[INVOICES])[1].date = "2026-10-21";
    });
    expect(diffs).toEqual([{ step: INVOICES, path: "$[1].date", expected: "2026-10-20", actual: "2026-10-21" }]);
  });
});

describe("normalize", () => {
  it("replaces generated IDs, the handout token, timestamps and today's date", () => {
    const n = createNormalizer({ today: TODAY });
    const w = world();
    expect(n.normalize(scenario(w, TODAY)[SESSION])).toEqual({
      id: "<s#1>",
      patientId: "<p#1>",
      status: "draft",
      handoutToken: "<token#1>",
      date: "<today>",
      consentAt: null,
      createdAt: "<ts>",
      finishedAt: null,
    });
  });

  it("numbers by first appearance across the whole run, so links survive between steps", () => {
    const n = createNormalizer({ today: TODAY });
    const [p, q, s1, s2, t1, t2] = [gid("p"), gid("p"), gid("s"), gid("s"), newToken(), newToken()];
    expect(n.normalize({ id: p })).toEqual({ id: "<p#1>" });
    expect(n.normalize({ id: q })).toEqual({ id: "<p#2>" });
    expect(n.normalize({ id: s1, patientId: q, handoutToken: t1 })).toEqual({
      id: "<s#1>",
      patientId: "<p#2>",
      handoutToken: "<token#1>",
    });
    expect(n.normalize({ id: s2, patientId: p, handoutToken: t2 })).toEqual({
      id: "<s#2>",
      patientId: "<p#1>",
      handoutToken: "<token#2>",
    });
    expect(n.normalize([{ sessionId: s1, handoutToken: t1 }])).toEqual([{ sessionId: "<s#1>", handoutToken: "<token#1>" }]);
  });

  it.each(["p", "a", "i", "n", "s", "r"])("recognises generated IDs with prefix %s", (prefix) => {
    const n = createNormalizer({ today: TODAY });
    expect(n.normalize({ id: gid(prefix) })).toEqual({ id: `<${prefix}#1>` });
  });

  it("leaves seed IDs as they are", () => {
    const n = createNormalizer({ today: TODAY });
    const seeds = { p: ["p1", "p2", "p3"], a: "a1", i: "i1", n: "n1" };
    expect(n.normalize(seeds)).toEqual(seeds);
  });

  it("leaves strings that only resemble generated IDs", () => {
    const n = createNormalizer({ today: TODAY });
    const body = { other: "x0123456789ab", short: "p0123456789a", long: "p0123456789abc" };
    expect(n.normalize(body)).toEqual(body);
  });

  it("keeps null and dates other than today", () => {
    const n = createNormalizer({ today: TODAY });
    const body = { consentAt: null, date: "2026-10-26", next: "2026-10-28" };
    expect(n.normalize(body)).toEqual(body);
  });
});

describe("diff", () => {
  it("reports nothing for equal values in a different key order", () => {
    expect(diff({ a: 1, b: { c: [1, 2], d: null } }, { b: { d: null, c: [1, 2] }, a: 1 })).toEqual([]);
  });

  it("gives the full JSON path of a nested difference", () => {
    const expected = { patient: { sessions: [{ status: "draft" }, { status: "final" }] } };
    const actual = { patient: { sessions: [{ status: "draft" }, { status: "draft" }] } };
    expect(diff(expected, actual)).toEqual([
      { path: "$.patient.sessions[1].status", expected: "final", actual: "draft" },
    ]);
  });
});

describe("isLocalBase: the guard that keeps the runner off the demo and staging", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["http://localhost:3211", "http://localhost:3211/", "http://127.0.0.1:3211", "http://[::1]:3211", "http://localhost"])(
    "allows %s",
    (base) => {
      expect(isLocalBase(base)).toBe(true);
    },
  );

  it.each([
    "https://mada-demo.up.railway.app",
    "https://mada-staging.up.railway.app",
    "http://localhost.example.com:3211",
    "http://localhost@example.com",
    "http://example.com/localhost",
    "http://127.0.0.1.nip.io:3211",
    "localhost:3211",
    "not a url",
    "",
  ])("refuses %j", (base) => {
    expect(isLocalBase(base)).toBe(false);
  });

  it("decides without sending a request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    isLocalBase("https://mada-demo.up.railway.app");
    isLocalBase("http://localhost:3211");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
