// Calls to InterviewPilot's backend. The browser never talks to it directly:
// it calls /api/backend/*, which this app's own server forwards (see
// next.config.ts). Locally that is the FastAPI process on this machine; in
// the cloud it is the backend deployment, with your sign-in token attached.

import { authHeaders } from "../auth";
import type { FaceToFaceResult } from "./store";

export const BACKEND = "/api/backend";
const CLOUD_BUILD = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export interface PlannedQuestion {
  id: string;
  text: string;
  category: string;
}

export interface InterviewPlan {
  /** A short, contact-free summary of the candidate for the interviewer. */
  candidate_brief: string;
  questions: PlannedQuestion[];
}

export interface AnswerScore {
  /** False when the turn was a clarification or small talk, not an answer. */
  is_answer: boolean;
  /** 0 to 10. */
  score: number;
  strengths: string[];
  improvements: string[];
  /** Claims in the answer that neither the resume nor your notes back up. */
  not_in_resume: string[];
  /** A follow-up worth asking, or null. */
  follow_up: string | null;
}

export interface ModelAnswer {
  model_answer: string;
  what_changed: string[];
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function readDetail(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    /* fall through */
  }
  return `The backend answered ${response.status}.`;
}

async function call<T>(
  path: string,
  init: { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal; grantId?: string | null } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeaders()) };
  // Paid mode: the interview's grant, which the backend checks and counts.
  if (init.grantId) headers["X-Interview-Grant"] = init.grantId;
  if (init.json !== undefined) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`${BACKEND}${path}`, {
      method: init.method ?? (init.json !== undefined || init.form ? "POST" : "GET"),
      headers,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
      signal: init.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new BackendError(
      CLOUD_BUILD
        ? "Couldn't reach InterviewPilot. Check your internet connection and try again."
        : "The InterviewPilot backend isn't reachable. Is it still running?",
      0,
    );
  }
  if (!response.ok) throw new BackendError(await readDetail(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- interview --------------------------------------------------------------

export function planInterview(input: {
  sessionId: string;
  role: string;
  questionCount: number;
  grantId?: string | null;
}): Promise<InterviewPlan> {
  return call("/face-to-face/plan", {
    json: { session_id: input.sessionId, role: input.role, question_count: input.questionCount },
    grantId: input.grantId,
  });
}

export function scoreAnswer(
  input: {
    sessionId: string;
    role: string;
    question: string;
    answer: string;
    allowFollowUp: boolean;
    grantId?: string | null;
  },
  signal?: AbortSignal,
): Promise<AnswerScore> {
  return call("/face-to-face/score", {
    json: {
      session_id: input.sessionId,
      role: input.role,
      question: input.question,
      answer: input.answer,
      allow_follow_up: input.allowFollowUp,
    },
    signal,
    grantId: input.grantId,
  });
}

export function modelAnswer(input: {
  sessionId: string | null;
  role: string;
  question: string;
  answer: string;
  grantId?: string | null;
}): Promise<ModelAnswer> {
  return call("/face-to-face/model-answer", {
    json: { session_id: input.sessionId, role: input.role, question: input.question, answer: input.answer },
    grantId: input.grantId,
  });
}

// --- billing (cloud, paid mode) --------------------------------------------------------

export interface Pack {
  id: string;
  /** credits: pay per interview, quantity picked at checkout. monthly: subscription. */
  kind: "credits" | "monthly";
  price_cents: number;
  label: string;
  max_quantity: number;
}

export interface Packs {
  enabled: boolean;
  currency: string;
  packs: Pack[];
  monthly_limit?: number;
}

export interface MonthlyPlan {
  status: string;
  active: boolean;
  renews_at: string;
  cancel_at_period_end: boolean;
  used: number;
  limit: number;
}

export interface BillingStatus {
  enabled: boolean;
  credits: number;
  unlimited: boolean;
  plan: MonthlyPlan | null;
}

/** Public: the price list (empty when payments are off). */
export async function getPacks(): Promise<Packs> {
  try {
    const response = await fetch(`${BACKEND}/billing/packs`, { cache: "no-store" });
    if (response.ok) return (await response.json()) as Packs;
  } catch {
    /* fall through */
  }
  return { enabled: false, currency: "usd", packs: [] };
}

export function getBillingStatus(): Promise<BillingStatus> {
  return call("/billing/status");
}

/** Returns the Stripe Checkout address to send the person to. */
export async function startCheckout(pack: string): Promise<string> {
  return (await call<{ url: string }>("/billing/checkout", { json: { pack } })).url;
}

/** Stripe's page to cancel the monthly plan or change the card. */
export async function openBillingPortal(): Promise<string> {
  return (await call<{ url: string }>("/billing/portal", { json: {} })).url;
}

/** Spends one credit and returns the interview's grant id ("local" when payments are off). */
export async function startInterview(): Promise<string> {
  return (await call<{ grant_id: string }>("/billing/start", { method: "POST" })).grant_id;
}

export function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// --- health, sessions -----------------------------------------------------------

export interface BackendHealth {
  ok: boolean;
  mode: "local" | "cloud";
  claude_configured: boolean;
  model?: string;
  vector_index?: string;
  sessions?: number;
  billing?: boolean;
}

export interface SessionMeta {
  id: string;
  role: string;
  filename: string;
  created_at: string;
  passage_count: number;
  has_job_description: boolean;
}

/** Null when the backend isn't reachable. */
export async function getHealth(): Promise<BackendHealth | null> {
  try {
    const response = await fetch(`${BACKEND}/health`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as BackendHealth;
    return body.ok ? body : null;
  } catch {
    return null;
  }
}

const MAX_RESUME_BYTES = 4 * 1024 * 1024;

/**
 * Reads the chosen file fully before uploading. On phones, a file picked from another app
 * (WhatsApp, Drive, email) is often a temporary link that breaks mid-upload; reading it first
 * turns that into a clear message instead of a "can't reach the server" error.
 */
async function readResume(file: File): Promise<Blob> {
  if (file.size > MAX_RESUME_BYTES) throw new BackendError("That file is over 4 MB. Upload a smaller copy.", 413);
  try {
    const bytes = await file.arrayBuffer();
    if (!bytes.byteLength) throw new Error("empty");
    return new Blob([bytes], { type: file.type || "application/octet-stream" });
  } catch {
    throw new BackendError(
      "Your phone couldn't open that file. Save the resume to your device first (for example to Downloads or Files), then choose it again.",
      0,
    );
  }
}

/** Uploads the resume; the backend extracts the text, strips contact details and indexes it. */
export async function createSession(input: { role: string; jobDescription: string; resume: File }): Promise<SessionMeta> {
  const resume = await readResume(input.resume);
  const send = () => {
    const form = new FormData();
    form.set("role", input.role);
    form.set("job_description", input.jobDescription);
    form.set("resume", resume, input.resume.name || "resume");
    return call<SessionMeta>("/sessions", { form });
  };
  try {
    return await send();
  } catch (error) {
    // One retry for a dropped mobile connection; real refusals (4xx/5xx) aren't retried.
    if (error instanceof BackendError && error.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return send();
    }
    throw error;
  }
}

/** The session, null when the backend no longer has it, undefined when it can't be checked. */
export async function getSession(id: string): Promise<SessionMeta | null | undefined> {
  try {
    return await call<SessionMeta>(`/sessions/${encodeURIComponent(id)}`);
  } catch (error) {
    return error instanceof BackendError && error.status === 404 ? null : undefined;
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await call(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof BackendError && error.status === 404)) throw error;
  }
}

// --- job postings -------------------------------------------------------------------

export interface JobPosting {
  role: string;
  company: string;
  location: string;
  job_description: string;
  source: "firecrawl" | "direct";
}

/** Reads a job posting from a link (Firecrawl, else a direct fetch). */
export function fetchJob(url: string): Promise<JobPosting> {
  return call("/jobs/fetch", { json: { url } });
}

// --- notes, history, account ---------------------------------------------------------

export async function getNotes(): Promise<string> {
  return (await call<{ notes: string }>("/profile/notes")).notes;
}

/** Saves the notes; returns them as stored (contact details removed). */
export async function saveNotes(notes: string): Promise<string> {
  return (await call<{ notes: string }>("/profile/notes", { method: "PUT", json: { notes } })).notes;
}

export function listInterviews(): Promise<FaceToFaceResult[]> {
  return call("/interviews");
}

export function saveInterview(result: FaceToFaceResult): Promise<FaceToFaceResult> {
  return call(`/interviews/${encodeURIComponent(result.id)}`, { method: "PUT", json: result });
}

export function clearInterviews(): Promise<void> {
  return call("/interviews", { method: "DELETE" });
}

export function deleteAllMyData(): Promise<void> {
  return call("/account/data", { method: "DELETE" });
}
