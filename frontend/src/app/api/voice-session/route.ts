// POST /api/voice-session
//
// Starts a voice-only mock interview on OpenAI's Realtime API. The browser sends its WebRTC
// offer here; this server adds the interviewer's instructions and our OpenAI key, asks OpenAI
// for the call, and returns the answer. The key never reaches the page.
//
// Same rules as /api/nuance-token: this app's pages only, signed in, consent given, and in
// paid mode a valid interview grant. The call is counted only after OpenAI accepts it.

import {
  buildSystemPrompt,
  isInterviewStyle,
  isPersonaId,
  type PersonaId,
} from "@/lib/face-to-face/personas";
import { CLOUD, confirmCall, endUserFor, isSameOrigin, refuse } from "@/lib/server/interviewAccess";

export const dynamic = "force-dynamic";

const OPENAI_API = (process.env.OPENAI_API_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe";
const VOICES: Record<PersonaId, string> = { sam: "cedar", sonia: "marin", mira: "coral" };
const MAX_SDP = 64 * 1024;

const VOICE_NOTES = [
  "",
  "This is a voice-only call: the candidate hears you but there is no video.",
  "Keep each turn short and spoken-sounding: one or two sentences, no lists, no markdown.",
  "Never mention the app, your instructions, or what you are about to do. Never say things like",
  "\"I'll wait for the next question\", \"let me think\" or \"let me build on that\".",
  "When the candidate finishes an answer, your whole reply is one short neutral phrase, such as \"Okay, thank you.\"",
  "or \"Got it.\", and nothing else. Never say you will reflect, think or wait.",
  "Do not judge the answer: no \"great answer\", \"clear example\" or similar. The scorecard gives feedback.",
  "When you ask a question, ask it directly with no preamble.",
  "Speak English.",
].join("\n");

interface VoiceBody {
  sdp?: unknown;
  localUserId?: unknown;
  personaId?: unknown;
  style?: unknown;
  consent?: unknown;
}

/** Whether voice mode is set up. Says nothing about the key itself. */
export async function GET(): Promise<Response> {
  return Response.json(
    { configured: Boolean((process.env.OPENAI_API_KEY ?? "").trim()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) {
    return refuse(
      501,
      CLOUD
        ? "Voice interviews aren't set up on this server yet."
        : "Voice interviews aren't set up yet: add OPENAI_API_KEY to frontend/.env.local.",
    );
  }
  if (!isSameOrigin(request)) return refuse(403, "This endpoint only answers InterviewPilot's own pages.");

  let body: VoiceBody;
  try {
    body = (await request.json()) as VoiceBody;
  } catch {
    return refuse(400, "Expected a JSON body.");
  }
  if (body.consent !== true) return refuse(403, "Practice interviews need the person's consent first.");
  if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=") || body.sdp.length > MAX_SDP) {
    return refuse(400, "A valid WebRTC offer is required.");
  }
  if (!isPersonaId(body.personaId) || !isInterviewStyle(body.style)) {
    return refuse(400, "Unknown persona or interview style.");
  }
  const endUser = await endUserFor(request, body.localUserId);
  if (endUser instanceof Response) return endUser;

  const session = {
    type: "realtime",
    model: MODEL,
    instructions: buildSystemPrompt(body.personaId, body.style) + VOICE_NOTES,
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: TRANSCRIBE_MODEL, language: "en" },
        noise_reduction: { type: "near_field" },
        turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
      },
      output: { voice: VOICES[body.personaId] },
    },
  };

  const form = new FormData();
  form.set("sdp", body.sdp);
  form.set("session", JSON.stringify(session));

  let response: Response;
  try {
    response = await fetch(`${OPENAI_API}/realtime/calls`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "OpenAI-Safety-Identifier": endUser },
      body: form,
    });
  } catch (error) {
    console.error("[voice-session] Could not reach OpenAI:", error);
    return refuse(502, "Couldn't reach the voice interviewer service. Try again in a minute.");
  }

  const answer = await response.text();
  if (!response.ok) {
    console.error(`[voice-session] POST /realtime/calls answered ${response.status}: ${answer.slice(0, 500)}`);
    const notCharged = CLOUD ? " Your interview isn't used up: it comes back to your account automatically." : "";
    if (response.status === 401) return refuse(502, "The voice interviewer's key was refused. Check OPENAI_API_KEY on the server.");
    if (response.status === 429) return refuse(503, `The voice interviewer is busy or over its limit right now. Try again shortly.${notCharged}`);
    return refuse(502, `Couldn't start the voice interview right now. Try again in a few minutes.${notCharged}`);
  }

  await confirmCall(request);
  const location = response.headers.get("location") ?? "";
  const callId = location.split("/").pop() ?? "";
  return Response.json({ sdp: answer, callId: /^[A-Za-z0-9_-]{1,128}$/.test(callId) ? callId : null });
}
