import { notFound } from "next/navigation";
import { connection } from "next/server";
import { sentryDebugEnabled } from "@/lib/server/sentryDebug";
import { ThrowButton } from "./ThrowButton";

export default async function SentryDebugPage() {
  // Read the flag per request, not at build time.
  await connection();
  if (!sentryDebugEnabled()) notFound();
  return (
    <main style={{ padding: "3rem 1.5rem" }}>
      <h1>Sentry verification</h1>
      <ThrowButton />
    </main>
  );
}
