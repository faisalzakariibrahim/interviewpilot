"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, Field, GoogleButton, useRedirectIfSignedIn } from "@/components/app/AuthCard";
import { logInWithPassword, sendPasswordReset, sendSignInLink } from "@/lib/auth";

type Mode = "password" | "forgot" | "link";

export default function LogInPage() {
  useRedirectIfSignedIn();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<null | "reset" | "link">(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const address = email.trim().toLowerCase();
    try {
      if (mode === "password") {
        await logInWithPassword(address, password);
        window.location.replace("/");
        return;
      }
      if (mode === "forgot") {
        await sendPasswordReset(address);
        setSent("reset");
      } else {
        await sendSignInLink(address);
        setSent("link");
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthCard title="Check your email">
        <p>
          {sent === "reset"
            ? "If there's an account for that email, we've sent a link to choose a new password."
            : "We've sent you a one-time sign-in link."}{" "}
          Open it on this device.
        </p>
        <p className="ip-muted">Nothing after a minute? Check spam, or <a href="/login">try again</a>.</p>
      </AuthCard>
    );
  }

  const switchTo = (next: Mode) => {
    setMode(next);
    setProblem(null);
  };

  return (
    <AuthCard
      title={mode === "forgot" ? "Reset your password" : mode === "link" ? "Get a sign-in link" : "Log in"}
      subtitle={
        mode === "forgot"
          ? "Enter your email and we'll send a link to choose a new password."
          : mode === "link"
            ? "No password needed: we'll email you a one-time link."
            : undefined
      }
    >
      {mode === "password" && <GoogleButton label="Continue with Google" />}
      <form onSubmit={(event) => void submit(event)}>
        <Field label="Email" type="email" autoComplete="email" required value={email}
          onChange={(event) => setEmail(event.target.value)} />
        {mode === "password" && (
          <Field label="Password" type="password" autoComplete="current-password" required value={password}
            onChange={(event) => setPassword(event.target.value)} />
        )}
        {problem && <p className="ip-banner is-alert" role="alert" style={{ marginTop: 12 }}>{problem}</p>}
        <button type="submit" className="ip-primary" disabled={busy} style={{ width: "100%", marginTop: 16 }}>
          {busy
            ? "One moment…"
            : mode === "password"
              ? "Log in"
              : mode === "forgot"
                ? "Send reset link"
                : "Email me a sign-in link"}
        </button>
      </form>
      <div className="ip-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginTop: 14, fontSize: 14 }}>
        {mode === "password" ? (
          <>
            <button type="button" className="ip-linkbutton" onClick={() => switchTo("forgot")}>Forgot password?</button>
            <button type="button" className="ip-linkbutton" onClick={() => switchTo("link")}>Email me a sign-in link instead</button>
          </>
        ) : (
          <button type="button" className="ip-linkbutton" onClick={() => switchTo("password")}>← Back to log in</button>
        )}
      </div>
      <p style={{ marginBottom: 0, textAlign: "center" }}>
        New here? <Link href="/signup">Create a free account</Link>
      </p>
    </AuthCard>
  );
}
