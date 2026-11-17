"use client";

// Runs one face-to-face mock interview: connects the Nuance conversation,
// plans the questions on the local backend, and hands the session's events to
// the InterviewDirector.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActiveSessionError,
  ApiError,
  LegalRequiredError,
  MaintenanceError,
  MediaAccessError,
  PolicyCurfewError,
  createNuanceConversation,
  type Conversation,
} from "@nuancelabs/js-sdk";
import { planInterview, saveInterview, scoreAnswer } from "./api";
import { authHeaders } from "../auth";
import { InterviewDirector, type DirectorSnapshot } from "./director";
import { averageScore, hasConsented, useFaceToFaceStore, type FaceToFaceResult } from "./store";

export type InterviewStatus =
  | "idle"
  | "starting" // planning questions and getting the interviewer ready
  | "live"
  | "ended"
  | "failed";

export interface UseFaceToFaceInterview {
  status: InterviewStatus;
  /** A message safe to show the person, when status is "failed". */
  failure: string | null;
  snapshot: DirectorSnapshot | null;
  result: FaceToFaceResult | null;
  videoRef: (element: HTMLVideoElement | null) => void;
  audioRef: (element: HTMLAudioElement | null) => void;
  start: () => Promise<void>;
  end: () => Promise<void>;
  /** Replaces the finished result, e.g. after a model answer is added. */
  updateResult: (result: FaceToFaceResult) => void;
}

interface Options {
  /** The InterviewPilot session whose resume is indexed on the backend. */
  sessionId: string;
  /** The role being practised for, e.g. "GSOC Analyst". */
  role: string;
  questionCount?: number;
  /** Longest a session may run. Nuance holds it to the account's maximum. */
  maxSessionSeconds?: number;
  /** Called with each finished interview once it is saved (or failed to save). */
  onFinished?: (result: FaceToFaceResult, saved: boolean) => void;
}

/** Turns a failed start into words for the person. Acts on fields, never on messages. */
function describeFailure(error: unknown): string {
  if (error instanceof MediaAccessError) {
    return error.device === "camera"
      ? "The camera couldn't be opened. Allow it in your browser, or turn the camera off in settings."
      : "The microphone couldn't be opened. Allow microphone access in your browser and try again.";
  }
  if (error instanceof PolicyCurfewError) {
    return "New face-to-face sessions are paused for now after repeated policy violations.";
  }
  if (error instanceof ActiveSessionError) {
    return "Another face-to-face session is already running on this account. End it first.";
  }
  if (error instanceof LegalRequiredError) {
    return "The Nuance account behind this app still needs to accept the developer agreement.";
  }
  if (error instanceof MaintenanceError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === "legal_blocked") {
      return "Face-to-face mode isn't offered in your region yet.";
    }
    if (error.status === 429) {
      return "Today's Nuance credits are used up. They renew daily.";
    }
    return "The interviewer service is busy right now. Try again in a minute.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't start the face-to-face session.";
}

export function useFaceToFaceInterview(options: Options): UseFaceToFaceInterview {
  const { sessionId, role, questionCount = 5, maxSessionSeconds = 20 * 60 } = options;
  const onFinishedRef = useRef(options.onFinished);
  onFinishedRef.current = options.onFinished;

  const [status, setStatus] = useState<InterviewStatus>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<DirectorSnapshot | null>(null);
  const [result, setResult] = useState<FaceToFaceResult | null>(null);

  const conversationRef = useRef<Conversation | null>(null);
  const directorRef = useRef<InterviewDirector | null>(null);
  const videoElement = useRef<HTMLVideoElement | null>(null);
  const audioElement = useRef<HTMLAudioElement | null>(null);
  const unsubscribers = useRef<Array<() => void>>([]);
  const runId = useRef(0);
  const finalizeRef = useRef<(() => void) | null>(null);

  const attachTracks = useCallback(() => {
    const conversation = conversationRef.current;
    if (!conversation || conversation.state !== "connected") return;
    if (videoElement.current) conversation.avatar.videoTrack?.attach(videoElement.current);
    if (audioElement.current) conversation.avatar.audioTrack?.attach(audioElement.current);
  }, []);

  const videoRef = useCallback(
    (element: HTMLVideoElement | null) => {
      videoElement.current = element;
      attachTracks();
    },
    [attachTracks],
  );
  const audioRef = useCallback(
    (element: HTMLAudioElement | null) => {
      audioElement.current = element;
      attachTracks();
    },
    [attachTracks],
  );

  const release = useCallback(() => {
    for (const off of unsubscribers.current) off();
    unsubscribers.current = [];
  }, []);

  const start = useCallback(async () => {
    const store = useFaceToFaceStore.getState();
    if (!hasConsented(store)) {
      setFailure("Accept the face-to-face disclosure first.");
      setStatus("failed");
      return;
    }

    const run = ++runId.current;
    release();
    setFailure(null);
    setResult(null);
    setSnapshot(null);
    setStatus("starting");
    const startedAt = new Date().toISOString();
    const { localUserId, personaId, style, cameraEnabled } = store;

    const conversation = createNuanceConversation({
      token: async () => {
        const response = await fetch("/api/nuance-token", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify({
            localUserId,
            personaId,
            style,
            camera: cameraEnabled,
            consent: true,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
        if (!response.ok || !body.token) throw new Error(body.error ?? "Couldn't get a session token.");
        return body.token;
      },
      mediaDevices: { cameraEnabled },
      maxSessionSeconds,
    });
    conversationRef.current = conversation;

    // Events can arrive before the plan is ready: hold them, then replay in order.
    let director: InterviewDirector | null = null;
    const held: Array<(d: InterviewDirector) => void> = [];
    const route = (deliver: (d: InterviewDirector) => void) => {
      if (director) deliver(director);
      else held.push(deliver);
    };

    let endReason = "ended";
    const finalize = () => {
      if (run !== runId.current) return;
      runId.current += 1; // one result per run
      release();
      const turns = director ? director.finish() : [];
      const finished: FaceToFaceResult = {
        id: (conversation.id ?? `local_${Date.now()}`).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128),
        sessionId,
        startedAt,
        endedAt: new Date().toISOString(),
        role,
        style,
        personaId,
        endReason,
        turns,
        average: averageScore(turns),
      };
      setResult(finished);
      setStatus("ended");
      if (turns.length) {
        saveInterview(finished)
          .then(() => onFinishedRef.current?.(finished, true))
          .catch(() => {
            setFailure("This scorecard couldn't be saved to your history. It's shown below until you leave the page.");
            onFinishedRef.current?.(finished, false);
          });
      }
    };
    finalizeRef.current = finalize;

    // Subscribe before connect() so the session's first events aren't missed.
    unsubscribers.current.push(
      conversation.onInterfaceEvent((event) => {
        route((d) => d.handleInterfaceEvent(event));
      }),
      conversation.onChange((event) => {
        if (run !== runId.current) return;
        switch (event.type) {
          case "tracks-changed":
            attachTracks();
            break;
          case "avatar-presented":
            attachTracks();
            route((d) => d.handlePresented());
            break;
          case "time-remaining":
            route((d) => d.handleTimeRemaining(event.secondsRemaining));
            break;
          case "session-ended":
            endReason = event.endReason ?? event.reason;
            if (event.reason === "policy-violation" || event.reason === "age-check") {
              setFailure(event.message ?? "The session was ended by a safety check.");
            }
            finalize();
            break;
          default:
            break;
        }
      }),
    );

    // Connect right away, inside the click, so the browser allows audio. The
    // interviewer takes up to half a minute to get ready; plan meanwhile.
    const connecting = conversation.connect();
    const planning = planInterview({ sessionId, role, questionCount });
    // Each is awaited below; this keeps a rejection from going unhandled meanwhile.
    connecting.catch(() => undefined);
    planning.catch(() => undefined);

    try {
      const plan = await planning;
      if (run !== runId.current) return;
      director = new InterviewDirector({
        conversation,
        plan,
        sessionId,
        role,
        score: scoreAnswer,
        onUpdate: (next) => {
          if (run === runId.current) setSnapshot(next);
        },
      });
      directorRef.current = director;
      setSnapshot(director.snapshot());
      for (const deliver of held.splice(0)) deliver(director);

      await connecting;
      if (run !== runId.current) return;
      setStatus((current) => (current === "starting" ? "live" : current));
    } catch (error) {
      if (run !== runId.current) return;
      runId.current += 1;
      release();
      void conversation.disconnect().catch(() => undefined);
      setFailure(describeFailure(error));
      setStatus("failed");
    }
  }, [attachTracks, maxSessionSeconds, questionCount, release, role, sessionId]);

  const end = useCallback(async () => {
    // disconnect() sends session.close and leaves the room. finalize() runs once
    // per session, so calling it here is safe if a session-ended event also comes.
    await conversationRef.current?.disconnect().catch(() => undefined);
    finalizeRef.current?.();
  }, []);

  // Leave the call when the component unmounts: the mic and camera turn off.
  useEffect(
    () => () => {
      runId.current += 1;
      release();
      directorRef.current?.finish();
      void conversationRef.current?.disconnect().catch(() => undefined);
    },
    [release],
  );

  return { status, failure, snapshot, result, videoRef, audioRef, start, end, updateResult: setResult };
}
