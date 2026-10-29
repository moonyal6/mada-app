import Link from "next/link";
import { listSessions } from "@/lib/server/db";
import { SessionWizard } from "@/components/session/SessionWizard";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

/**
 * The clinical session module. With ?id= it opens that session; without it,
 * it returns to the most recent draft (the prototype's "come back to the
 * ongoing session" behaviour) or shows the pick-a-patient empty state.
 */
export default async function SessionPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  const { id } = await searchParams;
  const sessionId =
    id ?? (await listSessions()).find((s) => s.status === "draft")?.id ?? null;

  if (!sessionId) {
    return (
      <div className="card">
        <div className="empty">
          <Icon name="session" strokeWidth={1.5} />
          <div>اختر مريضاً من سجل المرضى لبدء جلسة سريرية.</div>
          <Link
            href="/patients"
            className="btn btn-primary btn-sm"
            style={{ marginTop: 14 }}
          >
            فتح سجل المرضى
          </Link>
        </div>
      </div>
    );
  }

  return <SessionWizard sessionId={sessionId} />;
}
