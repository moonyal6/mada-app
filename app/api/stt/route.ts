import { cookies } from "next/headers";
import { STT_COOKIE } from "@/lib/stt";
import { sttStatus } from "@/lib/server/transcribe";

export const runtime = "nodejs";

/**
 * Which transcription providers exist, which are usable, and what this device
 * has chosen — the consent text and the recorder's picker read it. Keys and
 * secrets never leave the server; the browser sees names and availability.
 */
export async function GET() {
  const preferred = (await cookies()).get(STT_COOKIE)?.value;
  return Response.json(sttStatus(preferred));
}
