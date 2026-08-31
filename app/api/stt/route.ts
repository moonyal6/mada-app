import { sttStatus } from "@/lib/server/transcribe";

export const runtime = "nodejs";

/** Which transcription provider is active — the consent text names it. */
export async function GET() {
  return Response.json(sttStatus());
}
