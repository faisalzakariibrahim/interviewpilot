"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, Field, GoogleButton, useRedirectIfSignedIn } from "@/components/app/AuthCard";
import { signUpWithPassword } from "@/lib/auth";

function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Use at least 8 characters.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return "Mix letters and numbers.";
  return null;
}

export default function SignUpPage() {
  useRedirectIfSignedIn();
  const [firstName, setFirstName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adult, setAdult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<null | "check-email" | "already-registered">(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const weak = passwordProblem(password);
    if (weak) return setProblem(weak);
    setBusy(true);
    setProblem(null);
    try {
      const result = await signUpWithPassword(firstName, email.trim().toLowerCase(), password);
      if (result === "signed-in") window.location.replace("/?welcome=1");
      else setDone(result);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't create your account.");
    } finally {
      setBusy(false);
    }
  }

  if (done === "check-email") {
    return (
      <AuthCard title="Check your email">
        <p>
          We sent a confirmation link to <strong>{email.trim()}</strong>. Open it on this device to finish creating
          your account. Your first 3 interviews are free.
        </p>
        <p className="ip-muted">Nothing there after a minute? Check spam, or <a href="/signup">try again</a>.</p>
      </AuthCard>
    );
  }
  if (done === "already-registered") {
    return (
      <AuthCard title="You already have an account">
        <p>
          <strong>{email.trim()}</strong> is already signed up. <Link href="/login">Log in</Link> instead, or use
          &quot;Forgot password?&quot; there if you never set one.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your free account"
      subtitle="Your first 3 face-to-face mock interviews are free. No card needed."
    >
      <label style={{ display: "flex", gap: 10, margin: "0 0 14px", alignItems: "flex-start" }}>
        <input type="checkbox" checked={adult} onChange={(event) => setAdult(event.target.checked)} style={{ marginTop: 5, flex: "none", width: 16, height: 16 }} />
        <span style={{ flex: 1 }}>
          I&apos;m 18 or older and agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy</a> notice.
        </span>
      </label>
      <GoogleButton disabled={!adult} label="Sign up with Google" />
      <form onSubmit={(event) => void submit(event)}>
        <Field label="First name" autoComplete="given-name" required maxLength={40} value={firstName}
          onChange={(event) => setFirstName(event.target.value)} />
        <Field label="Email" type="email" autoComplete="email" required value={email}
          onChange={(event) => setEmail(event.target.value)} />
        <Field label="Password" type="password" autoComplete="new-password" required minLength={8} value={password}
          hint="At least 8 characters, with letters and numbers." onChange={(event) => setPassword(event.target.value)} />
        {problem && <p className="ip-banner is-alert" role="alert" style={{ marginTop: 12 }}>{problem}</p>}
        <button type="submit" className="ip-primary" disabled={busy || !adult} style={{ width: "100%", marginTop: 16 }}>
          {busy ? "Creating your account…" : "Create account"}
        </button>
        {!adult && <p className="ip-muted" style={{ fontSize: 13, marginBottom: 0 }}>Tick the box above to continue.</p>}
      </form>
      <p style={{ marginBottom: 0, textAlign: "center" }}>
        Already have an account? <Link href="/login">Log in</Link>
      </p>
    </AuthCard>
  );
}
