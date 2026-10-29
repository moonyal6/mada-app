import { finishSession, getSession } from "@/lib/server/db";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!(await getSession(id))) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json({ session: await finishSession(id) });
}
