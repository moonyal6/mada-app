import { describe, expect, it } from "vitest";
import { toAr } from "@/lib/arabic";

// Proves the runner is wired: TypeScript compiles, the `@/` alias resolves.
describe("test harness", () => {
  it("resolves @/lib imports", () => {
    expect(toAr(5)).toBe("٥");
  });
});
// probe: rule A
