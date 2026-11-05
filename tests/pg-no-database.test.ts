import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SERVER_START_MS,
  freePort,
  listDataDir,
  makeDataDir,
  request,
  startServer,
  testDatabaseUrl,
  withCleanup,
} from "./pg/harness.mjs";

// T5 of #30 (8b-2), written before the implementation. With no usable
// DATABASE_URL every request that needs the database fails loudly, a retry
// fails again, and nothing but recordings is written to MADA_DATA_DIR: the
// server never falls back to SQLite.
//
// The "unset" case removes DATABASE_URL from the server's environment, but
// `next start` still reads the env files in the repo root. If one of them
// sets DATABASE_URL, that case can't be tested on this machine and fails with
// a 200; CI has no env files.

/** The URL that matters here is the server's, but the suite still needs Postgres. */
const requirePostgres = () => testDatabaseUrl();

async function expectLoudFailure(env: Record<string, string | undefined>) {
  requirePostgres();
  await withCleanup(async (defer) => {
    const dataDir = makeDataDir();
    defer(() => rmSync(dataDir, { recursive: true, force: true }));
    const server = await startServer({ dataDir, env });
    defer(server.stop);

    // Twice each: a failed startup must not leave a server that answers
    // the next request from somewhere else.
    for (const urlPath of ["/api/patients", "/api/inventory", "/api/patients", "/api/inventory"]) {
      const res = await request(server.base, "GET", urlPath);
      expect(res.status, `GET ${urlPath} answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(500);
    }

    const entries = listDataDir(dataDir);
    expect(entries.filter((f) => f.startsWith("mada.db")), "mada.db* files: the server fell back to SQLite").toEqual([]);
    expect(
      entries.filter((f) => f !== "recordings"),
      "MADA_DATA_DIR holds nothing but (possibly) recordings",
    ).toEqual([]);
  });
}

describe("no usable database (#30, 8b-2)", () => {
  const timeout = SERVER_START_MS + 60_000;

  it("T5: DATABASE_URL unset → requests fail loudly, no SQLite file", () => expectLoudFailure({ DATABASE_URL: undefined }), timeout);

  it("T5: DATABASE_URL empty → requests fail loudly, no SQLite file", () => expectLoudFailure({ DATABASE_URL: "" }), timeout);

  it(
    "T5: DATABASE_URL on a closed port → requests fail loudly, no SQLite file",
    async () => {
      const port = await freePort();
      await expectLoudFailure({ DATABASE_URL: `postgres://mada:mada@127.0.0.1:${port}/mada` });
    },
    timeout,
  );
});
