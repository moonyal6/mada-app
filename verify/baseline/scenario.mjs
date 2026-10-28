// The baseline scenario: named steps, run in order against a fresh instance.
//
// Placeholder (#7, 7a): one read, so the runner can be shown working end to
// end. 7b replaces it with the full scenario.
//
// A step is { name, method, path, body?, headers?, finding? }. `path` and
// `body` may be functions of the earlier steps' raw response bodies, keyed by
// step name, for steps that need an ID an earlier step created. `finding`
// marks a recorded response as a known bug; `--record` copies it into the
// fixture and every replay prints it.

/** @type {import("../baseline.mjs").Step[]} */
export const steps = [{ name: "inventory: seed list", method: "GET", path: "/api/inventory" }];
