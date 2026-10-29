import "server-only";
import type { AdherenceSummary, ClinicalSession } from "@/lib/types";
import {
  clinicToday,
  getDb,
  listAdherence,
  listPainLogs,
  listSessions,
} from "./db";

function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000,
  );
}

function riyadhDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** The plan the patient is currently on: latest finished session with exercises. */
export async function currentPlanSession(
  patientId: string,
): Promise<ClinicalSession | null> {
  return (
    (await listSessions(patientId)).find(
      (s) => s.status === "final" && Object.keys(s.selected).length > 0,
    ) ?? null
  );
}

/**
 * Adherence over the last 7 days (or since the plan started, if newer):
 * checked exercise-day cells / (exercises × days). Null when there is no
 * finished plan — the follow-up screen shows an honest "—", never a made-up
 * percentage.
 */
export async function adherenceForSession(
  session: ClinicalSession,
): Promise<AdherenceSummary> {
  const exCount = Object.keys(session.selected).length;
  const startDay = session.finishedAt
    ? riyadhDay(session.finishedAt)
    : session.date;
  const today = clinicToday();
  const daysElapsed = Math.max(1, Math.min(7, dayDiff(startDay, today) + 1));
  const windowStart = dayDiff(startDay, today) + 1 > 7 ? undefined : startDay;

  const logs = await listAdherence(session.id);
  const inWindow = (day: string) =>
    dayDiff(day, today) < daysElapsed &&
    dayDiff(day, today) >= 0 &&
    (windowStart === undefined || dayDiff(windowStart, day) >= 0);

  const checked = logs.filter((l) => l.done && inWindow(l.day)).length;
  const slots = exCount * daysElapsed;

  const pains = await listPainLogs(session.id);
  const lastPainRow = pains[pains.length - 1];
  const lastLogAt =
    (
      (await getDb())
        .prepare(
          `SELECT MAX(t) AS t FROM (
             SELECT MAX(updatedAt) AS t FROM adherence WHERE sessionId=@id
             UNION ALL
             SELECT MAX(updatedAt) AS t FROM pain_logs WHERE sessionId=@id
           )`,
        )
        .get({ id: session.id }) as { t: string | null }
    ).t ?? null;

  return {
    pct: slots > 0 ? Math.min(100, Math.round((checked / slots) * 100)) : null,
    checked,
    slots,
    lastPain: lastPainRow ? lastPainRow.pain : null,
    lastLogAt,
  };
}

export async function adherenceForPatient(
  patientId: string,
): Promise<AdherenceSummary> {
  const plan = await currentPlanSession(patientId);
  if (!plan) {
    return { pct: null, checked: 0, slots: 0, lastPain: null, lastLogAt: null };
  }
  return adherenceForSession(plan);
}
