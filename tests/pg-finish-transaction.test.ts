import { describe, expect, it } from "vitest";
import { SERVER_START_MS, request, withServerOnFreshDb } from "./pg/harness.mjs";

// T7 of #30 (8b-2), written before the implementation. Finishing a session
// marks it final and creates its invoice in one transaction. A trigger the
// test installs makes every invoice insert fail; the session must then stay
// a draft with no finishedAt. Repeating the failure more times than the
// pool's default of 10 clients proves each failed transaction gives its
// client back, rolled back: the server still answers afterwards.

const FORCED_FAILURES = 12;

describe("finishSession on Postgres (#30, 8b-2)", () => {
  it(
    "T7: a failed invoice insert leaves the session a draft, and the pool survives 12 such failures",
    () =>
      withServerOnFreshDb(async ({ db, server }) => {
        const first = await request(server.base, "GET", "/api/patients");
        expect(first.status, JSON.stringify(first.body)).toBe(200);

        const created = await request(server.base, "POST", "/api/sessions", { body: { patientId: "p1" } });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const id: string = created.body.session.id;

        const invoicesBefore = await db.query("SELECT id FROM invoices ORDER BY id");

        await db.query(`
          CREATE FUNCTION mada_test_fail_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'invoice insert forced to fail by the T7 test';
          END
          $$`);
        await db.query(
          "CREATE TRIGGER mada_test_fail_invoice BEFORE INSERT ON invoices FOR EACH ROW EXECUTE FUNCTION mada_test_fail_invoice()",
        );

        for (let i = 1; i <= FORCED_FAILURES; i++) {
          const res = await request(server.base, "POST", `/api/sessions/${id}/finish`, { timeoutMs: 10_000 });
          expect(res.status, `forced failure ${i}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(500);

          const after = await request(server.base, "GET", `/api/sessions/${id}`, { timeoutMs: 10_000 });
          expect(after.status, `GET the session after forced failure ${i}`).toBe(200);
          expect(after.body.session, `after forced failure ${i}`).toMatchObject({ status: "draft", finishedAt: null });
        }

        const row = await db.query(`SELECT status, "finishedAt" FROM sessions WHERE id = $1`, [id]);
        expect(row).toEqual([{ status: "draft", finishedAt: null }]);
        expect(await db.query("SELECT id FROM invoices ORDER BY id")).toEqual(invoicesBefore);

        const patients = await request(server.base, "GET", "/api/patients", { timeoutMs: 10_000 });
        expect(patients.status, `GET /api/patients after ${FORCED_FAILURES} forced failures`).toBe(200);
      }),
    SERVER_START_MS + 120_000,
  );
});
