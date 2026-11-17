import Link from "next/link";
import type { ReactNode } from "react";

export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "";
export const OPERATOR = process.env.NEXT_PUBLIC_OPERATOR_NAME ?? "Flicktek";

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="ip-shell" style={{ maxWidth: 760 }}>
      <p>
        <Link href="/">← InterviewPilot</Link>
      </p>
      <h1 style={{ fontSize: 28, marginBottom: 4 }}>{title}</h1>
      <p className="ip-muted" style={{ marginTop: 0 }}>Last updated {updated}</p>
      <div className="ip-legal">{children}</div>
      <p className="ip-muted" style={{ marginTop: 32 }}>
        Questions: {SUPPORT_EMAIL ? <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> : "use the contact on your receipt"}.
      </p>
    </main>
  );
}
