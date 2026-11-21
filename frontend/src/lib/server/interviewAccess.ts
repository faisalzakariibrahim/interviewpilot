// Server-only checks shared by the interviewer routes (/api/nuance-token, /api/voice-session).
// Every route that starts a paid conversation on our keys goes through these.

export const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
export const CLOUD = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
/** An opaque per-person id: letters, digits and _ . : - only, up to 128 characters. */
export const END_USER_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

export function refuse(status: number, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...extra }, { status });
}

/**
 * Accepts only calls from this app's own pages. Locally there is no sign-in, so without this
 * any website open in the same browser could start conversations on your keys.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Cloud: asks the backend who the bearer token belongs to and, in paid mode, whether this
 * interview may still start a call. Returns an opaque `ref` to send to the provider instead
 * of anything that identifies the person. The call is counted later, by confirmCall, only
 * once the provider has actually started it.
 */
export async function whoIsAsking(request: Request): Promise<{ ref: string } | Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return refuse(401, "Sign in first.");
  try {
    const grant = request.headers.get("x-interview-grant");
    const response = await fetch(`${BACKEND_URL}/api/billing/authorize-call`, {
      method: "POST",
      headers: { Authorization: authorization, ...(grant ? { "X-Interview-Grant": grant } : {}) },
      cache: "no-store",
    });
    if (response.status === 402) {
      const detail = ((await response.json().catch(() => ({}))) as { detail?: string }).detail;
      return refuse(402, detail ?? "Start the interview again.");
    }
    if (!response.ok) return refuse(response.status === 403 ? 403 : 401, "Sign in again to start an interview.");
    const me = (await response.json()) as { ref?: unknown };
    if (typeof me.ref !== "string" || !END_USER_ID.test(me.ref)) return refuse(502, "Couldn't confirm your sign-in.");
    return { ref: me.ref };
  } catch {
    return refuse(503, "Couldn't confirm your sign-in right now.");
  }
}

/** After the provider started the conversation: count the call against the interview's grant. */
export async function confirmCall(request: Request): Promise<void> {
  const authorization = request.headers.get("authorization");
  const grant = request.headers.get("x-interview-grant");
  if (!authorization || !grant) return;
  try {
    await fetch(`${BACKEND_URL}/api/billing/authorize-call?confirm=true`, {
      method: "POST",
      headers: { Authorization: authorization, "X-Interview-Grant": grant },
      cache: "no-store",
    });
  } catch (error) {
    console.error("[interview] Couldn't record the call:", error);
  }
}

/** Resolves who the conversation is for: the backend's opaque ref (cloud) or the page's random id (local). */
export async function endUserFor(request: Request, localUserId: unknown): Promise<string | Response> {
  if (CLOUD) {
    const who = await whoIsAsking(request);
    return who instanceof Response ? who : who.ref;
  }
  if (typeof localUserId !== "string" || !END_USER_ID.test(localUserId)) {
    return refuse(400, "localUserId is missing or malformed.");
  }
  return localUserId;
}
