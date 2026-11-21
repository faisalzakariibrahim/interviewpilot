"use client";

// Sign-in for cloud mode. Local mode has no sign-in: the app only answers
// pages served from this computer.
//
// Cloud mode is on when the build has NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY. Both are public by design: what protects your
// data is row-level security in the database plus the backend's allowlist,
// not secrecy of these two values.

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useState } from "react";

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const CLOUD = Boolean(URL && ANON);

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient | null {
  if (!CLOUD || typeof window === "undefined") return null;
  client ??= createClient(URL, ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "interviewpilot-auth",
    },
  });
  return client;
}

/** The signed-in user's access token, or null (always null in local mode). */
export async function accessToken(): Promise<string | null> {
  const sb = supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Headers for calls to our own server: the bearer token in cloud mode. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type AuthState =
  | { status: "local" }
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; email: string; userId: string; firstName: string };

/** First name from email signup, or from Google's profile. */
function firstNameOf(session: Session): string {
  const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
  const raw = meta.first_name ?? meta.given_name ?? (typeof meta.full_name === "string" ? meta.full_name.split(" ")[0] : "") ?? "";
  return String(raw).trim().slice(0, 40);
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>(CLOUD ? { status: "loading" } : { status: "local" });
  useEffect(() => {
    const sb = supabase();
    if (!sb) return;
    const apply = (session: Session | null) =>
      setState(
        session
          ? { status: "signed-in", email: session.user.email ?? "", userId: session.user.id, firstName: firstNameOf(session) }
          : { status: "signed-out" },
      );
    void sb.auth.getSession().then(({ data }) => apply(data.session));
    const { data } = sb.auth.onAuthStateChange((_event, session) => apply(session));
    return () => data.subscription.unsubscribe();
  }, []);
  return state;
}

/** Emails a one-time sign-in link that brings the person back to this page. */
export async function sendSignInLink(email: string): Promise<void> {
  const sb = supabase();
  if (!sb) throw new Error("Sign-in isn't set up.");
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
}

function requireClient(): SupabaseClient {
  const sb = supabase();
  if (!sb) throw new Error("Sign-in isn't set up.");
  return sb;
}

/** Plain-English versions of Supabase's auth errors. */
function friendly(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login credentials")) return "That email and password don't match. Try again, or use \"Forgot password?\".";
  if (m.includes("email not confirmed")) return "Confirm your email first: open the link we sent you, then log in.";
  if (m.includes("rate limit")) return "Too many emails sent just now. Wait a minute and try again.";
  if (m.includes("provider is not enabled") || m.includes("unsupported provider"))
    return "Google sign-in isn't switched on yet. Use email and password for now.";
  if (m.includes("password should be") || m.includes("weak password")) return "Choose a stronger password: at least 8 characters, mixing letters and numbers.";
  if (m.includes("same password")) return "That's your current password. Choose a new one.";
  return message;
}

export type SignUpResult = "check-email" | "signed-in" | "already-registered";

/** Creates an account. Supabase emails a confirmation link unless confirmation is off. */
export async function signUpWithPassword(firstName: string, email: string, password: string): Promise<SignUpResult> {
  const { data, error } = await requireClient().auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName.trim().slice(0, 40) }, emailRedirectTo: `${window.location.origin}/` },
  });
  if (error) throw new Error(friendly(error.message));
  // For privacy, Supabase answers an existing email with an empty identity list instead of an error.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return "already-registered";
  return data.session ? "signed-in" : "check-email";
}

export async function logInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await requireClient().auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error.message));
}

/** Leaves for Google's sign-in page and comes back signed in. */
export async function continueWithGoogle(): Promise<void> {
  const { error } = await requireClient().auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${window.location.origin}/` },
  });
  if (error) throw new Error(friendly(error.message));
}

export async function sendPasswordReset(email: string): Promise<void> {
  const { error } = await requireClient().auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) throw new Error(friendly(error.message));
}

export async function setNewPassword(password: string): Promise<void> {
  const { error } = await requireClient().auth.updateUser({ password });
  if (error) throw new Error(friendly(error.message));
}

/** Google sign-in is on unless this deployment sets NEXT_PUBLIC_GOOGLE_SIGNIN=off. */
export const GOOGLE_ENABLED = CLOUD && process.env.NEXT_PUBLIC_GOOGLE_SIGNIN !== "off";

export async function signOut(): Promise<void> {
  const sb = supabase();
  if (!sb) return;
  await sb.auth.signOut();
  // Leave nothing of the previous person's in this browser: storage, and the page's memory
  // (a fresh load), so the next person to sign in here starts clean.
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("interviewpilot")) localStorage.removeItem(key);
    }
    sessionStorage.clear();
  } catch {
    /* storage unavailable */
  }
  window.location.replace("/");
}
