// POST /api/nuance-token
//
// Mints a one-use Nuance session token for a face-to-face mock interview.
// The Nuance API key stays on this server; the page only ever sees the token.
// Web-standard handler: runs as a Next.js route handler as written.

import {
  STYLE_SPECS,
  buildSystemPrompt,
  isInterviewStyle,
  isPersonaId,
} from "@/lib/face-to-face/personas";

export const dynamic = "force-dynamic";

const NUANCE_API = process.env.NUANCE_API_URL ?? "https://api.nuancelabs.ai";
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const CLOUD = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
// Nuance: letters, digits and _ . : - only, up to 128 characters.
const END_USER_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

interface TokenBody {
  localUserId?: unknown;
  personaId?: unknown;
  style?: unknown;
  camera?: unknown;
  consent?: unknown;
}

function refuse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Accepts only calls from this app's own pages. Locally there is no sign-in,
 * so without this any website open in the same browser could start
 * conversations on your key. In the cloud a signed-in, allowlisted user is
 * required as well (see whoIsAsking).
 */
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Whether face-to-face mode is set up. Says nothing about the key itself. */
export async function GET(): Promise<Response> {
  return Response.json(
    { configured: Boolean((process.env.NUANCE_API_KEY ?? "").trim()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Cloud: asks the backend who the bearer token belongs to. The backend checks
 * it with Supabase and against the allowlist, and returns an opaque `ref`
 * that is sent to Nuance instead of anything that identifies the person.
 * Local: the page's random id is used.
 */
/** After Nuance started the session: count the call against the interview's grant. */
async function confirmCall(request: Request): Promise<void> {
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
    console.error("[nuance-token] Couldn't record the call:", error);
  }
}

/** "in about 3 hours" until Nuance's daily credits renew. */
function untilRenewal(renewsAt: unknown): string {
  const when = typeof renewsAt === "string" ? Date.parse(renewsAt) : NaN;
  if (!Number.isFinite(when)) return "later today";
  const minutes = Math.max(1, Math.round((when - Date.now()) / 60000));
  if (minutes < 60) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

async function whoIsAsking(request: Request): Promise<{ ref: string } | Response> {
  const authorization = request.headers.get("authorization");
  if (!authorization) return refuse(401, "Sign in first.");
  try {
    // The backend checks the sign-in and, in paid mode, that this interview may still start a call.
    // The call is only counted after Nuance actually starts it (see confirmCall).
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

export async function POST(request: Request): Promise<Response> {
  // A stray space or line break pasted with the key would make Nuance refuse it.
  const nuanceKey = (process.env.NUANCE_API_KEY ?? "").trim();
  if (!nuanceKey) {
    return refuse(
      501,
      CLOUD
        ? "Face-to-face mode is not set up on this server yet."
        : "Face-to-face mode is not set up yet: add NUANCE_API_KEY to frontend/.env.local.",
    );
  }
  if (!isSameOrigin(request)) {
    return refuse(403, "This endpoint only answers InterviewPilot's own pages.");
  }

  let body: TokenBody;
  try {
    body = (await request.json()) as TokenBody;
  } catch {
    return refuse(400, "Expected a JSON body.");
  }

  // Opt-in gate: the page sends this only after the person accepts the disclosure.
  if (body.consent !== true) {
    return refuse(403, "Face-to-face mode needs the person's consent first.");
  }
  let endUserId: string;
  if (CLOUD) {
    const who = await whoIsAsking(request);
    if (who instanceof Response) return who;
    endUserId = who.ref;
  } else {
    if (typeof body.localUserId !== "string" || !END_USER_ID.test(body.localUserId)) {
      return refuse(400, "localUserId is missing or malformed.");
    }
    endUserId = body.localUserId;
  }
  if (!isPersonaId(body.personaId) || !isInterviewStyle(body.style)) {
    return refuse(400, "Unknown persona or interview style.");
  }
  const camera = body.camera === true;

  let response: Response;
  try {
    response = await fetch(`${NUANCE_API}/session-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${nuanceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        interface: "nuance_live",
        personality: {
          persona_id: body.personaId,
          system_prompt: buildSystemPrompt(body.personaId, body.style),
        },
        expressiveness: STYLE_SPECS[body.style].expressiveness,
        interface_setup: {
          // Scoring happens on this machine from the transcript, so the persona
          // hands nothing off to Nuance's backend.
          delegation: { type: "none" },
          // Camera off means the persona never looks at it and it isn't recorded.
          video: { input: { camera } },
          runtime_tools: { end_call: true, call_time: true },
        },
          // An opaque id, so a policy pause stops one person, not the account.
        end_user_id: endUserId,
      }),
    });
  } catch (error) {
    console.error("[nuance-token] Could not reach Nuance:", error);
    return refuse(502, "Couldn't reach Nuance Labs. Check your internet connection and try again.");
  }

  if (!response.ok) {
    // For you, in the server log. The page gets a plain-English message.
    const text = await response.text();
    console.error(`[nuance-token] POST /session-tokens answered ${response.status}: ${text}`);
    let info: { code?: string; renews_at?: string } = {};
    try {
      info = JSON.parse(text) as typeof info;
    } catch {
      /* not JSON */
    }
    const notCharged = CLOUD ? " Your interview isn't used up: it comes back to your account automatically." : "";
    if (response.status === 429 && info.code === "credits_spent") {
      return refuse(
        503,
        `The video interviewer has reached its daily limit. It's available again ${untilRenewal(info.renews_at)}.${notCharged}`,
      );
    }
    if (response.status === 429) {
      return refuse(503, `The video interviewer is busy right now. Try again in a minute.${notCharged}`);
    }
    if (response.status >= 500) {
      return refuse(503, `The video interviewer is having problems right now. Try again in a few minutes.${notCharged}`);
    }
    if (response.status === 401) {
      return refuse(
        502,
        CLOUD
          ? "Nuance didn't accept the server's API key. Re-run deploy-cloud.sh after checking frontend/.env.local."
          : "Nuance didn't accept the API key. Check NUANCE_API_KEY in frontend/.env.local.",
      );
    }
    return refuse(
      502,
      CLOUD
        ? "Couldn't start the video interview right now. Try again in a few minutes."
        : "Couldn't start a face-to-face session right now. Details are in .logs/frontend.log.",
    );
  }

  const { token, warnings } = (await response.json()) as {
    token: string;
    warnings?: string[];
  };
  if (warnings?.length) console.warn("[nuance-token] warnings:", warnings);
  await confirmCall(request);
  return Response.json({ token });
}
