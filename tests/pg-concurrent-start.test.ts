import { describe, expect, it } from "vitest";
import { SERVER_START_MS, request, withServerOnFreshDb } from "./pg/harness.mjs";

// T6 of #30 (8b-2), written before the implementation. Twenty requests
// arrive at once on a server that has never touched its (empty) database.
// Startup — migrate and seed — must happen once: every request succeeds,
// and the seed is there exactly once.

describe("concurrent first requests (#30, 8b-2)", () => {
  it(
    "T6: 20 parallel first requests on a fresh database all return 200, and the seed lands once",
    () =>
      withServerOnFreshDb(async ({ db, server }) => {
        const paths = Array.from({ length: 20 }, (_, i) => (i % 2 ? "/api/inventory" : "/api/patients"));
        const results = await Promise.all(paths.map((p) => request(server.base, "GET", p, { timeoutMs: 30_000 })));
        const statuses = results.map((r, i) => `${paths[i]} ${r.status}`);
        expect(statuses).toEqual(paths.map((p) => `${p} 200`));

        for (const r of results) {
          const list = r.body.patients ?? r.body.inventory;
          expect(Array.isArray(list), JSON.stringify(r.body).slice(0, 200)).toBe(true);
        }
        const patientIds = results.filter((_, i) => paths[i] === "/api/patients").map((r) => r.body.patients.map((p: { id: string }) => p.id).sort());
        for (const ids of patientIds) expect(ids).toEqual(["p1", "p2", "p3"]);
        const itemIds = results.filter((_, i) => paths[i] === "/api/inventory").map((r) => r.body.inventory.map((n: { id: string }) => n.id));
        for (const ids of itemIds) expect(ids).toEqual(["n1", "n2", "n3", "n4"]);

        // And in the database itself.
        const patients = await db.query("SELECT id FROM patients ORDER BY id");
        expect(patients.map((r) => r.id)).toEqual(["p1", "p2", "p3"]);
        const inventory = await db.query("SELECT id FROM inventory ORDER BY id");
        expect(inventory.map((r) => r.id)).toEqual(["n1", "n2", "n3", "n4"]);
      }),
    SERVER_START_MS + 60_000,
  );

  // Added on the owner's approval after the first draft: the advisory lock
  // alone keeps the seed single even when every request runs startup, so the
  // test above can stay green without a shared startup promise. This one sees
  // startup run again. Once startup has run, the test holds an ACCESS
  // EXCLUSIVE lock on schema_migrations. A request that only reads patients
  // never touches that table and answers; one that runs startup again has to
  // read it to know what is applied, blocks on the lock, and times out.
  it(
    "T6: startup runs once per process — a later request doesn't touch schema_migrations",
    () =>
      withServerOnFreshDb(async ({ db, server, defer }) => {
        const first = await request(server.base, "GET", "/api/patients");
        expect(first.status, JSON.stringify(first.body).slice(0, 200)).toBe(200);

        const locker = await db.connect();
        defer(() => locker.end());
        await locker.query("BEGIN");
        await locker.query("LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE");
        try {
          const later = await request(server.base, "GET", "/api/patients", { timeoutMs: 8_000 }).catch(
            (e: Error) => ({ status: 0, body: `${e.message} (startup ran again and waited on schema_migrations?)` }),
          );
          expect(later.status, JSON.stringify(later.body).slice(0, 200)).toBe(200);
        } finally {
          await locker.query("ROLLBACK");
        }
      }),
    SERVER_START_MS + 60_000,
  );
});
