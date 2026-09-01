import type { ReactNode } from "react";
import { ClinicShell } from "@/components/layout/ClinicShell";

export default function ClinicLayout({ children }: { children: ReactNode }) {
  return <ClinicShell>{children}</ClinicShell>;
}
