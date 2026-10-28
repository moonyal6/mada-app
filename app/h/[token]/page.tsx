import type { Metadata } from "next";
import {
  clinicToday,
  getPatient,
  getSessionByToken,
  listAdherence,
  listPainLogs,
} from "@/lib/server/db";
import { caseLabel } from "@/lib/format";
import { therapistOf } from "@/lib/therapist";
import { PatientHandout } from "@/components/patient/PatientHandout";
import { BrandMark } from "@/components/BrandMark";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "مدى — نشرة البرنامج المنزلي",
};

/**
 * The patient's page. Reached only through the unguessable handout token —
 * no login, no clinic chrome. Reads go straight to the DB; writes go through
 * /api/handout/[token]/log.
 */
export default async function HandoutPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getSessionByToken(token);
  const patient = session ? getPatient(session.patientId) : null;

  if (!session || !patient) {
    return (
      <div className="pt-wrap">
        <div className="pt-card" style={{ marginTop: 40, textAlign: "center" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
            <BrandMark size={40} />
          </div>
          <h2>الرابط غير صحيح</h2>
          <p className="sub" style={{ marginBottom: 0 }}>
            تأكد من الرابط في نشرتك، أو تواصل مع عيادتك للحصول على رابط جديد.
          </p>
        </div>
      </div>
    );
  }

  const exercises = Object.values(session.selected).map((ex) => ({
    ar: ex.ar,
    en: ex.en,
    desc: ex.desc,
    url: ex.url,
    image: ex.image ?? "",
  }));

  return (
    <PatientHandout
      token={token}
      patientName={patient.name}
      therapistName={therapistOf(session)}
      caseText={caseLabel(patient.caseKey)}
      sessionDate={session.date}
      home={session.home}
      frequency={session.frequency}
      follow={session.follow}
      advice={session.advice}
      exercises={exercises}
      today={clinicToday()}
      initialAdherence={await listAdherence(session.id)}
      initialPains={(await listPainLogs(session.id)).map(({ day, pain }) => ({ day, pain }))}
    />
  );
}
