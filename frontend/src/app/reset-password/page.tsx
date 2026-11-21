"use client";

// Where the "reset your password" email lands. The link signs the person in for this one
// purpose; they choose a new password and continue to the app.

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthCard, Field } from "@/components/app/AuthCard";
import { setNewPassword, useAuth } from "@/lib/auth";

export default function ResetPasswordPage() {
  const auth = useAuth();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
      setProblem("Use at least 8 characters, mixing letters and numbers.");
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await setNewPassword(password);
      window.location.replace("/");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't save your new password.");
      setBusy(false);
    }
  }

  if (auth.status === "loading") return <AuthCard title="Choose a new password"><p className="ip-muted">Checking your link…</p></AuthCard>;
  if (auth.status !== "signed-in") {
    return (
      <AuthCard title="This link has expired">
        <p>
          Reset links work once, for a short time, on the device that asked for them.{" "}
          <Link href="/login">Request a new one</Link>.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" subtitle={`For ${auth.email}`}>
      <form onSubmit={(event) => void submit(event)}>
        <Field label="New password" type="password" autoComplete="new-password" required minLength={8} value={password}
          hint="At least 8 characters, with letters and numbers." onChange={(event) => setPassword(event.target.value)} />
        {problem && <p className="ip-banner is-alert" role="alert" style={{ marginTop: 12 }}>{problem}</p>}
        <button type="submit" className="ip-primary" disabled={busy} style={{ width: "100%", marginTop: 16 }}>
          {busy ? "Saving…" : "Save and continue"}
        </button>
      </form>
    </AuthCard>
  );
}
