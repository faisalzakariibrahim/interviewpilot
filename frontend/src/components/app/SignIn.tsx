"use client";

import { useState, type FormEvent } from "react";
import { sendSignInLink } from "@/lib/auth";

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await sendSignInLink(email.trim());
      setSent(true);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't send the sign-in link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ip-card" aria-labelledby="signin-title" style={{ maxWidth: 520, margin: "40px auto" }}>
      <h2 id="signin-title">Sign in</h2>
      {sent ? (
        <p>
          Check your email for a sign-in link, then open it in this browser. You can close this tab once
          you&apos;re in.
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <p className="ip-muted" style={{ margin: 0 }}>
            This InterviewPilot is private. You&apos;ll get a one-time link by email; only invited emails can
            use it.
          </p>
          <label className="ip-field">
            <span>Email</span>
            <input
              className="ip-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {problem && (
            <p className="ip-banner is-alert" role="alert" style={{ marginTop: 12 }}>
              {problem}
            </p>
          )}
          <button type="submit" className="ip-primary" style={{ marginTop: 16 }} disabled={busy}>
            {busy ? "Sending" : "Email me a sign-in link"}
          </button>
        </form>
      )}
    </section>
  );
}
