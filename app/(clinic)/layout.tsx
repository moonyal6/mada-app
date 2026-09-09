import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { ClinicShell } from "@/components/layout/ClinicShell";
import { THERAPIST_COOKIE, decodeTherapistCookie } from "@/lib/therapist";

export default async function ClinicLayout({ children }: { children: ReactNode }) {
  // The device's chosen therapist, read here so server and client render the
  // same sidebar (no hydration mismatch, no flash of the fallback name).
  const therapist = decodeTherapistCookie(
    (await cookies()).get(THERAPIST_COOKIE)?.value,
  );
  return <ClinicShell initialTherapist={therapist}>{children}</ClinicShell>;
}
