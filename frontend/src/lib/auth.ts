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
  | { status: "signed-in"; email: string; userId: string };

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>(CLOUD ? { status: "loading" } : { status: "local" });
  useEffect(() => {
    const sb = supabase();
    if (!sb) return;
    const apply = (session: Session | null) =>
      setState(
        session
          ? { status: "signed-in", email: session.user.email ?? "", userId: session.user.id }
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
