import { createPatient, listPatients, nextFileNo } from "@/lib/server/db";
import { currentClinicId } from "@/lib/server/clinic";
import { isCaseKey } from "@/lib/data/cases";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ patients: await listPatients(await currentClinicId()) });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const caseKey = typeof body.caseKey === "string" ? body.caseKey : "";
  if (!name || !isCaseKey(caseKey)) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const clinicId = await currentClinicId();
  const patient = await createPatient(clinicId, {
    name,
    phone: typeof body.phone === "string" ? body.phone.trim() : "",
    fileNo:
      typeof body.fileNo === "string" && body.fileNo.trim()
        ? body.fileNo.trim()
        : await nextFileNo(clinicId),
    age: typeof body.age === "number" && body.age > 0 ? body.age : null,
    sex: typeof body.sex === "string" ? body.sex : "",
    caseKey,
    complaint: typeof body.complaint === "string" ? body.complaint.trim() : "",
    status: "نشط",
  });
  return Response.json({ patient }, { status: 201 });
}
