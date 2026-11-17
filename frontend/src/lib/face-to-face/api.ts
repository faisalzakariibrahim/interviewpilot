// Calls to InterviewPilot's backend. The browser never talks to it directly:
// it calls /api/backend/*, which this app's own server forwards (see
// next.config.ts). Locally that is the FastAPI process on this machine; in
// the cloud it is the backend deployment, with your sign-in token attached.

import { authHeaders } from "../auth";
import type { FaceToFaceResult } from "./store";

export const BACKEND = "/api/backend";

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
  init: { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { ...(await authHeaders()) };
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
    throw new BackendError("The InterviewPilot backend isn't reachable. Is it still running?", 0);
  }
  if (!response.ok) throw new BackendError(await readDetail(response), response.status);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- interview --------------------------------------------------------------

export function planInterview(input: { sessionId: string; role: string; questionCount: number }): Promise<InterviewPlan> {
  return call("/face-to-face/plan", {
    json: { session_id: input.sessionId, role: input.role, question_count: input.questionCount },
  });
}

export function scoreAnswer(
  input: { sessionId: string; role: string; question: string; answer: string; allowFollowUp: boolean },
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
  });
}

export function modelAnswer(input: {
  sessionId: string | null;
  role: string;
  question: string;
  answer: string;
}): Promise<ModelAnswer> {
  return call("/face-to-face/model-answer", {
    json: { session_id: input.sessionId, role: input.role, question: input.question, answer: input.answer },
  });
}

// --- health, sessions -----------------------------------------------------------

export interface BackendHealth {
  ok: boolean;
  mode: "local" | "cloud";
  claude_configured: boolean;
  model?: string;
  vector_index?: string;
  sessions?: number;
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

/** Uploads the resume; the backend extracts the text, strips contact details and indexes it. */
export function createSession(input: { role: string; jobDescription: string; resume: File }): Promise<SessionMeta> {
  const form = new FormData();
  form.set("role", input.role);
  form.set("job_description", input.jobDescription);
  form.set("resume", input.resume);
  return call("/sessions", { form });
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
