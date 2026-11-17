"use client";

// Face-to-face mock interview: an opt-in mode of mock practice.
// Shows the disclosure first; nothing connects to Nuance until it is accepted.
//
// Styling uses CSS custom properties with fallbacks. Point the --f2f-* names
// at your design tokens (deep navy / electric blue) in globals.css.

import { useEffect, useState, type CSSProperties } from "react";
import {
  INTERVIEW_STYLES,
  PERSONA_IDS,
  STYLE_SPECS,
} from "@/lib/face-to-face/personas";
import { modelAnswer, saveInterview } from "@/lib/face-to-face/api";
import { hasConsented, useFaceToFaceStore, type FaceToFaceResult } from "@/lib/face-to-face/store";
import { useFaceToFaceInterview } from "@/lib/face-to-face/useFaceToFaceInterview";

interface Props {
  /** The InterviewPilot session whose resume is indexed on the backend. */
  sessionId: string;
  /** The role being practised for. */
  role: string;
  questionCount?: number;
  /** When set, Start is disabled and this is shown: for example a missing key. */
  blockedReason?: string | null;
  /** Called with each finished interview, after it is saved. */
  onFinished?: (result: FaceToFaceResult, saved: boolean) => void;
}

const css = {
  panel: {
    background: "var(--f2f-surface, #0b1530)",
    color: "var(--f2f-text, #e8eeff)",
    border: "1px solid var(--f2f-border, #1e2c55)",
    borderRadius: 16,
    padding: 24,
    maxWidth: 880,
    margin: "0 auto 20px",
    lineHeight: 1.55,
  },
  h2: { margin: "0 0 12px", fontSize: 22 },
  h3: { margin: "20px 0 8px", fontSize: 16 },
  muted: { color: "var(--f2f-muted, #9fb0d9)", fontSize: 14 },
  list: { margin: "8px 0 0", paddingLeft: 20 },
  row: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" },
  primary: {
    background: "var(--f2f-accent, #2f6bff)",
    color: "#fff",
    border: 0,
    borderRadius: 10,
    padding: "12px 20px",
    fontSize: 16,
    fontWeight: 600,
    cursor: "pointer",
  },
  ghost: {
    background: "transparent",
    color: "var(--f2f-text, #e8eeff)",
    border: "1px solid var(--f2f-border, #1e2c55)",
    borderRadius: 10,
    padding: "10px 16px",
    fontSize: 15,
    cursor: "pointer",
  },
  select: {
    background: "var(--f2f-surface-2, #101d3f)",
    color: "inherit",
    border: "1px solid var(--f2f-border, #1e2c55)",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 15,
  },
  video: {
    width: "100%",
    aspectRatio: "16 / 9",
    background: "#000",
    borderRadius: 12,
    objectFit: "cover",
  },
  card: {
    background: "var(--f2f-surface-2, #101d3f)",
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
  },
  modelAnswer: {
    background: "var(--f2f-accent-soft, #16275c)",
    border: "1px solid var(--f2f-border, #1e2c55)",
    borderRadius: 10,
    padding: 14,
  },
  alert: {
    background: "var(--f2f-alert, #3a1620)",
    border: "1px solid var(--f2f-alert-border, #7a2c3f)",
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
  },
} satisfies Record<string, CSSProperties>;

function Disclosure({ onAccept }: { onAccept: () => void }) {
  const [adult, setAdult] = useState(false);
  const [understood, setUnderstood] = useState(false);
  return (
    <section style={css.panel} aria-labelledby="f2f-disclosure-title">
      <h2 id="f2f-disclosure-title" style={css.h2}>
        Face-to-face practice is optional, and it is not local
      </h2>
      <p>
        InterviewPilot keeps your resume, its search index and your sessions on this computer.
        Face-to-face mode is the one exception: the video interviewer is run by Nuance Labs on
        their servers, so a live call has to leave your machine.
      </p>

      <h3 style={css.h3}>What is sent to Nuance Labs during a call</h3>
      <ul style={css.list}>
        <li>Your microphone audio, for the whole call.</li>
        <li>Your camera video, only if you turn the camera on. It is off by default.</li>
        <li>The interview questions and a short summary of your experience for the role.</li>
      </ul>
      <p style={css.muted}>
        Nuance Labs records calls and runs automated safety checks on them. Their terms and
        privacy policy apply to that data, not InterviewPilot&apos;s.
      </p>

      <h3 style={css.h3}>What goes to Claude (Anthropic), in any mode</h3>
      <ul style={css.list}>
        <li>
          Resume passages with contact details removed, the job description, the questions and the
          transcript of your answers. Claude uses them to plan the interview and score it, through your
          own Anthropic API key.
        </li>
      </ul>

      <h3 style={css.h3}>What stays on this computer</h3>
      <ul style={css.list}>
        <li>Your resume file and the search index built from it.</li>
        <li>Your scorecards and session history.</li>
        <li>
          Your email, phone number, links and ID-like numbers: these are stripped before anything is
          stored or sent.
        </li>
      </ul>

      <h3 style={css.h3}>Good to know</h3>
      <ul style={css.list}>
        <li>The interviewer is an AI and its video carries a visible watermark.</li>
        <li>Don&apos;t read out phone numbers, card numbers or ID numbers. A safety check can end the call.</li>
        <li>English only for now, and availability depends on your region.</li>
        <li>You can turn face-to-face mode off again at any time.</li>
      </ul>

      <div style={{ ...css.card, display: "grid", gap: 10 }}>
        <label style={css.row}>
          <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
          <span>I am 18 or older.</span>
        </label>
        <label style={css.row}>
          <input
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
          />
          <span>I understand my call audio is sent to and recorded by Nuance Labs.</span>
        </label>
      </div>

      <div style={{ ...css.row, marginTop: 16 }}>
        <button
          type="button"
          style={{ ...css.primary, opacity: adult && understood ? 1 : 0.5 }}
          disabled={!adult || !understood}
          onClick={onAccept}
        >
          Turn on face-to-face practice
        </button>
      </div>
    </section>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  behavioral: "Behavioral",
  technical: "Technical",
  situational: "Situational",
  motivation: "Motivation",
  experience: "Experience",
};

function TurnCard({
  result,
  index,
  onChange,
}: {
  result: FaceToFaceResult;
  index: number;
  onChange?: (result: FaceToFaceResult) => void;
}) {
  const turn = result.turns[index]!;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function strengthen() {
    setBusy(true);
    setProblem(null);
    try {
      const made = await modelAnswer({
        sessionId: result.sessionId ?? null,
        role: result.role,
        question: turn.question,
        answer: turn.answer,
      });
      const updated: FaceToFaceResult = {
        ...result,
        turns: result.turns.map((item, i) => (i === index ? { ...item, modelAnswer: made } : item)),
      };
      onChange?.(updated);
      await saveInterview(updated).catch(() => {
        setProblem("Shown here, but it couldn't be saved to your history.");
      });
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't write a stronger answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article style={css.card}>
      <p style={{ ...css.muted, margin: "0 0 4px" }}>
        {turn.isFollowUp ? "Follow-up" : "Question"}
        {turn.category ? ` · ${CATEGORY_LABELS[turn.category] ?? turn.category}` : ""}
      </p>
      <p style={{ margin: 0, fontWeight: 600 }}>{turn.question}</p>
      <p style={{ ...css.muted, margin: "8px 0" }}>You said: {turn.answer}</p>
      {turn.score ? (
        <>
          <p style={{ margin: "8px 0", fontWeight: 600 }}>{turn.score.score} / 10</p>
          {turn.score.strengths.length > 0 && (
            <>
              <p style={{ margin: "8px 0 0" }}>What worked</p>
              <ul style={css.list}>
                {turn.score.strengths.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {turn.score.improvements.length > 0 && (
            <>
              <p style={{ margin: "8px 0 0" }}>What to tighten</p>
              <ul style={css.list}>
                {turn.score.improvements.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {turn.score.not_in_resume.length > 0 && (
            <>
              <p style={{ margin: "8px 0 0" }}>Not backed by your resume or notes</p>
              <ul style={css.list}>
                {turn.score.not_in_resume.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : (
        <p style={css.muted}>This answer was saved but couldn&apos;t be scored.</p>
      )}

      {turn.modelAnswer ? (
        <div style={{ ...css.modelAnswer, marginTop: 12 }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>A stronger way to say it</p>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{turn.modelAnswer.model_answer}</p>
          {turn.modelAnswer.what_changed.length > 0 && (
            <ul style={{ ...css.list, ...css.muted }}>
              {turn.modelAnswer.what_changed.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <p style={{ ...css.muted, margin: "8px 0 0" }}>
            Built only from what you said, your resume and your notes. Fill in anything in [brackets] with
            what really happened.
          </p>
        </div>
      ) : (
        onChange && (
          <button type="button" style={{ ...css.ghost, marginTop: 12 }} disabled={busy} onClick={() => void strengthen()}>
            {busy ? "Writing a stronger answer" : "Show a stronger answer"}
          </button>
        )
      )}
      {problem && <p style={{ ...css.muted, margin: "8px 0 0" }}>{problem}</p>}
    </article>
  );
}

export function Scorecard({
  result,
  onChange,
}: {
  result: FaceToFaceResult;
  /** Pass to allow "Show a stronger answer"; receives the updated result. */
  onChange?: (result: FaceToFaceResult) => void;
}) {
  if (!result.turns.length) {
    return <p style={css.muted}>The session ended before any answer was recorded.</p>;
  }
  return (
    <div>
      <h3 style={css.h3}>
        Scorecard{result.average !== null ? `: ${result.average} / 10 average` : ""}
      </h3>
      {result.turns.map((turn, i) => (
        <TurnCard key={`${turn.questionId}-${i}`} result={result} index={i} onChange={onChange} />
      ))}
    </div>
  );
}

export function FaceToFaceInterview({ sessionId, role, questionCount = 5, blockedReason = null, onFinished }: Props) {
  const store = useFaceToFaceStore();
  const consented = hasConsented(store);
  const interview = useFaceToFaceInterview({ sessionId, role, questionCount, onFinished });
  const { status, snapshot, result, failure } = interview;
  const inCall = status === "starting" || status === "live";

  // Settings come from localStorage: render only in the browser, after it is read.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  if (!consented) return <Disclosure onAccept={store.acceptDisclosure} />;

  return (
    <section style={css.panel} aria-label="Face-to-face mock interview">
      <h2 style={css.h2}>Face-to-face practice: {role}</h2>

      {!inCall && (
        <div style={{ ...css.row, marginBottom: 16 }}>
          <label style={css.row}>
            <span>Interviewer</span>
            <select
              style={css.select}
              value={store.personaId}
              onChange={(e) => {
                const id = PERSONA_IDS.find((p) => p === e.target.value);
                if (id) store.setPersonaId(id);
              }}
            >
              {PERSONA_IDS.map((id) => (
                <option key={id} value={id}>
                  {id.charAt(0).toUpperCase() + id.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label style={css.row}>
            <span>Style</span>
            <select
              style={css.select}
              value={store.style}
              onChange={(e) => {
                const style = INTERVIEW_STYLES.find((s) => s === e.target.value);
                if (style) store.setStyle(style);
              }}
            >
              {INTERVIEW_STYLES.map((style) => (
                <option key={style} value={style}>
                  {STYLE_SPECS[style].label}
                </option>
              ))}
            </select>
          </label>
          <label style={css.row}>
            <input
              type="checkbox"
              checked={store.cameraEnabled}
              onChange={(e) => store.setCameraEnabled(e.target.checked)}
            />
            <span>Let the interviewer see me (sends camera video)</span>
          </label>
        </div>
      )}
      {!inCall && <p style={css.muted}>{STYLE_SPECS[store.style].blurb}</p>}

      {/* Kept mounted so the persona's tracks have somewhere to attach. */}
      <div style={{ display: inCall ? "block" : "none" }}>
        <video ref={interview.videoRef} style={css.video} autoPlay playsInline />
        <audio ref={interview.audioRef} autoPlay />
      </div>

      {status === "starting" && (
        <p style={css.muted} role="status">
          Getting your interviewer ready. This can take up to half a minute.
        </p>
      )}

      {inCall && snapshot && (
        <div style={css.card} aria-live="polite">
          <p style={{ ...css.muted, margin: 0 }}>
            {snapshot.phase === "wrapping"
              ? "Wrapping up"
              : `Question ${snapshot.questionNumber} of ${snapshot.questionTotal}`}
            {snapshot.scoring ? " · scoring your answer" : ""}
          </p>
          {snapshot.interviewerLive && <p style={{ margin: "8px 0 0" }}>{snapshot.interviewerLive}</p>}
          {snapshot.youLive && (
            <p style={{ ...css.muted, margin: "8px 0 0" }}>You: {snapshot.youLive}</p>
          )}
          {snapshot.notice && <p style={{ ...css.muted, margin: "8px 0 0" }}>{snapshot.notice}</p>}
        </div>
      )}

      {failure && (
        <p style={css.alert} role="alert">
          {failure}
        </p>
      )}

      <div style={{ ...css.row, marginTop: 16 }}>
        {inCall ? (
          <button type="button" style={css.ghost} onClick={() => void interview.end()}>
            End interview
          </button>
        ) : (
          // Start from a click, so the browser plays the interviewer's audio.
          <button
            type="button"
            style={{ ...css.primary, opacity: blockedReason ? 0.5 : 1 }}
            disabled={Boolean(blockedReason)}
            onClick={() => void interview.start()}
          >
            {status === "failed" ? "Try again" : status === "ended" ? "Start another interview" : "Start interview"}
          </button>
        )}
        {!inCall && (
          <button type="button" style={css.ghost} onClick={store.withdrawConsent}>
            Turn off face-to-face mode
          </button>
        )}
      </div>

      {blockedReason && !inCall && <p style={{ ...css.muted, marginTop: 12 }}>{blockedReason}</p>}

      {status === "ended" && result && (
        <Scorecard
          result={result}
          onChange={(updated) => {
            interview.updateResult(updated);
            onFinished?.(updated, true);
          }}
        />
      )}
    </section>
  );
}

export default FaceToFaceInterview;
