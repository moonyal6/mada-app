import "server-only";
import { clinicExists } from "./db";

/** The clinic every process serves until MADA_CLINIC_ID says otherwise. */
const DEFAULT_CLINIC_ID = "c1";

/**
 * The clinic this request acts for (#9). For now it is the process's
 * MADA_CLINIC_ID, or c1 when that is unset; real auth replaces this body
 * later without touching callers, which is why it is async. Nothing else
 * knows where the clinic comes from.
 *
 * Throws when the id is not in `clinics`, so the request fails, the log
 * names the id, and nothing is written.
 */
export async function currentClinicId(): Promise<string> {
  const id = process.env.MADA_CLINIC_ID || DEFAULT_CLINIC_ID;
  if (!(await clinicExists(id))) {
    throw new Error(`Unknown clinic "${id}" (MADA_CLINIC_ID): no such row in clinics.`);
  }
  return id;
}
