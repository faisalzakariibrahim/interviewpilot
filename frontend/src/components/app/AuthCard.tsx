"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { continueWithGoogle, GOOGLE_ENABLED, useAuth } from "@/lib/auth";

/** The frame shared by /signup, /login and /reset-password. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <main className="ip-shell" style={{ maxWidth: 480 }}>
      <p style={{ margin: "8px 0 24px" }}>
        <Link href="/" style={{ color: "var(--ip-text)", textDecoration: "none", fontWeight: 700, fontSize: 20 }}>
          InterviewPilot
        </Link>
      </p>
      <section className="ip-card">
        <h1 style={{ fontSize: 24, margin: "0 0 6px" }}>{title}</h1>
        {subtitle && <p className="ip-muted" style={{ marginTop: 0 }}>{subtitle}</p>}
        {children}
      </section>
      <p className="ip-muted" style={{ textAlign: "center", fontSize: 13 }}>
        <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
      </p>
    </main>
  );
}

/** Sends people who are already signed in to the app. */
export function useRedirectIfSignedIn() {
  const auth = useAuth();
  useEffect(() => {
    if (auth.status === "signed-in" || auth.status === "local") window.location.replace("/");
  }, [auth.status]);
  return auth;
}

export function GoogleButton({ disabled, label }: { disabled?: boolean; label: string }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!GOOGLE_ENABLED) return null;
  return (
    <>
      <button
        type="button"
        className="ip-ghost"
        disabled={disabled || busy}
        onClick={() => {
          setBusy(true);
          setProblem(null);
          continueWithGoogle().catch((error: unknown) => {
            setProblem(error instanceof Error ? error.message : "Couldn't open Google sign-in.");
            setBusy(false);
          });
        }}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "11px 14px" }}
      >
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.1C12.4 13.7 17.7 9.5 24 9.5z" />
          <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" />
          <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z" />
          <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
        </svg>
        {busy ? "Opening Google…" : label}
      </button>
      {problem && <p className="ip-banner is-alert" role="alert" style={{ marginTop: 10 }}>{problem}</p>}
      <div className="ip-row" style={{ gap: 10, margin: "16px 0 4px" }} aria-hidden="true">
        <span style={{ flex: 1, height: 1, background: "var(--ip-border)" }} />
        <span className="ip-muted" style={{ fontSize: 13 }}>or with email</span>
        <span style={{ flex: 1, height: 1, background: "var(--ip-border)" }} />
      </div>
    </>
  );
}

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="ip-field">
      <span>{label}</span>
      <input className="ip-input" {...input} />
      {hint && <small className="ip-muted">{hint}</small>}
    </label>
  );
}
