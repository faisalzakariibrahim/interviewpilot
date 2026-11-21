// Face-to-face settings, persisted in this browser (localStorage). Interview
// history lives in the backend (backend/data locally, encrypted in the cloud);
// `results` here only holds history from older versions until it is moved.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AnswerScore, ModelAnswer, SessionMeta } from "./api";
import type { InterviewStyle, PersonaId } from "./personas";

/** Bump when the disclosure text changes, so people are asked again. */
// 2: adds OpenAI for voice-only interviews.
export const DISCLOSURE_VERSION = 2;

export interface ScoredTurn {
  questionId: string;
  question: string;
  /** behavioral, technical, situational, motivation or experience. Missing on old results. */
  category?: string;
  isFollowUp: boolean;
  answer: string;
  /** Null when scoring failed; the answer is still kept. */
  score: AnswerScore | null;
  /** A stronger version of the answer, made on request after the interview. */
  modelAnswer?: ModelAnswer;
}

export interface FaceToFaceResult {
  id: string;
  /** The practice session (resume) it ran against. Missing on old results. */
  sessionId?: string;
  /** Paid mode: the grant this interview ran under; stronger answers are counted against it. */
  grantId?: string;
  startedAt: string;
  endedAt: string;
  role: string;
  style: InterviewStyle;
  personaId: PersonaId;
  endReason: string;
  /** "voice" when it ran voice-only; missing means video. */
  mode?: "voice";
  turns: ScoredTurn[];
  /** Mean of the scored answers, 0 to 10, or null when none were scored. */
  average: number | null;
}

interface FaceToFaceState {
  /**
   * Cloud mode: the signed-in account this browser data belongs to. When another account signs
   * in on the same browser, everything below is wiped before anything is shown.
   */
  ownerId: string | null;
  /** A random per-person id sent to the interviewer providers for abuse checks. Never a name or email. */
  localUserId: string;
  consentVersion: number | null;
  consentAt: string | null;
  cameraEnabled: boolean;
  /** Video (face-to-face avatar) or voice only. */
  mode: "video" | "voice";
  style: InterviewStyle;
  personaId: PersonaId;
  /** History from versions before it moved to the backend. Emptied once moved. */
  results: FaceToFaceResult[];
  /** The practice session in use: which resume and role. The resume itself lives in the backend. */
  session: SessionMeta | null;
  questionCount: number;
  /** The welcome email was requested for this account (the server sends it at most once). */
  welcomeRequested: boolean;
  setWelcomeRequested: () => void;
  setSession: (session: SessionMeta | null) => void;
  setQuestionCount: (count: number) => void;
  acceptDisclosure: () => void;
  withdrawConsent: () => void;
  setCameraEnabled: (on: boolean) => void;
  setMode: (mode: "video" | "voice") => void;
  setStyle: (style: InterviewStyle) => void;
  setPersonaId: (id: PersonaId) => void;
  clearLegacyResults: () => void;
  /** Wipes everything belonging to the previous person and marks the data as this account's. */
  resetFor: (ownerId: string | null) => void;
}

function newLocalUserId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ip_${random}`;
}

function personalDefaults() {
  return {
    localUserId: newLocalUserId(),
    consentVersion: null,
    consentAt: null,
    cameraEnabled: false,
    mode: "video" as const,
    style: "neutral" as InterviewStyle,
    personaId: "sam" as PersonaId,
    results: [] as FaceToFaceResult[],
    session: null,
    questionCount: 5,
    welcomeRequested: false,
  };
}

export const useFaceToFaceStore = create<FaceToFaceState>()(
  persist(
    (set) => ({
      ownerId: null,
      localUserId: newLocalUserId(),
      consentVersion: null,
      consentAt: null,
      // Off by default: the interviewer works without seeing you.
      cameraEnabled: false,
      mode: "video",
      style: "neutral",
      personaId: "sam",
      results: [],
      session: null,
      questionCount: 5,
      welcomeRequested: false,
      setWelcomeRequested: () => set({ welcomeRequested: true }),
      setSession: (session) => set({ session }),
      setQuestionCount: (questionCount) => set({ questionCount }),
      acceptDisclosure: () =>
        set({ consentVersion: DISCLOSURE_VERSION, consentAt: new Date().toISOString() }),
      withdrawConsent: () => set({ consentVersion: null, consentAt: null, cameraEnabled: false }),
      setCameraEnabled: (cameraEnabled) => set({ cameraEnabled }),
      setMode: (mode) => set({ mode }),
      setStyle: (style) => set({ style }),
      setPersonaId: (personaId) => set({ personaId }),
      clearLegacyResults: () => set({ results: [] }),
      resetFor: (ownerId) => set({ ...personalDefaults(), ownerId }),
    }),
    {
      name: "interviewpilot-face-to-face",
      // v2 adds ownerId. Older saved data has no owner, so the first cloud sign-in wipes it.
      version: 2,
      migrate: (persisted) => ({ ...(persisted as object), ownerId: null }) as FaceToFaceState,
    },
  ),
);

export function hasConsented(state: Pick<FaceToFaceState, "consentVersion">): boolean {
  return state.consentVersion === DISCLOSURE_VERSION;
}

export function averageScore(turns: ScoredTurn[]): number | null {
  const scores = turns.flatMap((turn) => (turn.score ? [turn.score.score] : []));
  if (!scores.length) return null;
  return Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10;
}
