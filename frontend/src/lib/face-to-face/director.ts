// The interview director: plain TypeScript, no React and no SDK imports, so it
// can be unit-tested with a fake conversation.
//
// It listens to the Nuance Live events of one session and runs the interview:
//   1. briefs the persona and has it open with the first question,
//   2. collects each answer from the settled transcript,
//   3. scores it on this machine (FastAPI + Claude + local FAISS),
//   4. tells the persona what to ask next: a follow-up or the next question,
//   5. wraps the call up after the last one.
//
// The persona never decides what gets scored. The transcript does.

import type { AnswerScore, InterviewPlan } from "./api";
import { safeLine, scrubContactDetails, toLineChunks } from "./sanitize";
import type { ScoredTurn } from "./store";

/** The slice of the SDK's Conversation the director uses. */
export interface DirectorConversation {
  append(
    kind: "thinking" | "instructions" | "commentary",
    content: string,
    options?: { whileSpeaking?: "finish" | "revise" },
  ): Promise<void>;
  sendInterfaceEvent(event: Record<string, unknown>): Promise<void>;
  disconnect(): Promise<void>;
}

export type ScoreFn = (
  input: { sessionId: string; role: string; question: string; answer: string; allowFollowUp: boolean },
  signal?: AbortSignal,
) => Promise<AnswerScore>;

export type DirectorPhase = "waiting" | "live" | "wrapping" | "ended";

export interface TranscriptLine {
  who: "interviewer" | "you";
  text: string;
}

export interface DirectorSnapshot {
  phase: DirectorPhase;
  questionNumber: number;
  questionTotal: number;
  currentQuestion: string | null;
  lines: TranscriptLine[];
  interviewerLive: string;
  youLive: string;
  scoring: boolean;
  turns: ScoredTurn[];
  /** The last non-fatal problem worth showing, or null. */
  notice: string | null;
}

export interface DirectorOptions {
  conversation: DirectorConversation;
  plan: InterviewPlan;
  sessionId: string;
  role: string;
  score: ScoreFn;
  onUpdate: (snapshot: DirectorSnapshot) => void;
  /** Follow-ups allowed per planned question. Default 1. */
  maxFollowUps?: number;
  /** How long the persona gets to say goodbye before the page hangs up. Default 25 s. */
  wrapUpTimeoutMs?: number;
}

interface CurrentQuestion {
  id: string;
  text: string;
  category: string;
  isFollowUp: boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export class InterviewDirector {
  private readonly options: DirectorOptions;
  private phase: DirectorPhase = "waiting";
  private started = false;
  private presented = false;
  private opened = false;

  private index = 0;
  private followUpsUsed = 0;
  private current: CurrentQuestion | null = null;
  /** True from the moment a question is sent until the persona has asked it. */
  private askPending = false;
  private replyCountsAsAsk = false;

  private interviewerLive = "";
  private youLive = "";
  private readonly lines: TranscriptLine[] = [];
  private readonly turns: ScoredTurn[] = [];

  /** Parts of the answer under way, keyed by transcript event id, in order. */
  private answerParts = new Map<string, string>();
  private scoreSeq = 0;
  private scoreAbort: AbortController | null = null;
  private scoring = false;
  private notice: string | null = null;
  private wrapTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: DirectorOptions) {
    this.options = options;
  }

  snapshot(): DirectorSnapshot {
    return {
      phase: this.phase,
      questionNumber: Math.min(this.index + 1, this.options.plan.questions.length),
      questionTotal: this.options.plan.questions.length,
      currentQuestion: this.current?.text ?? null,
      lines: [...this.lines],
      interviewerLive: this.interviewerLive,
      youLive: this.youLive,
      scoring: this.scoring,
      turns: [...this.turns],
      notice: this.notice,
    };
  }

  /** Call when the SDK reports `avatar-presented`. */
  handlePresented(): void {
    this.presented = true;
    void this.maybeOpen();
  }

  /** Call when the SDK reports `time-remaining`. */
  handleTimeRemaining(secondsRemaining: number): void {
    if (this.phase === "live" && secondsRemaining <= 60) void this.wrapUp("time");
  }

  /** Call with every event from `conversation.onInterfaceEvent`. */
  handleInterfaceEvent(event: Record<string, unknown>): void {
    switch (event.type) {
      case "session.started":
        this.started = true;
        void this.maybeOpen();
        break;
      case "session.output_transcript.delta":
        if (!this.interviewerLive) this.replyCountsAsAsk = this.askPending;
        this.interviewerLive += text(event.delta);
        this.emit();
        break;
      case "session.output_audio.done":
        this.onInterviewerReplyDone();
        break;
      case "session.input_transcript.delta":
        this.youLive += text(event.delta);
        this.emit();
        break;
      case "session.input_transcript.done":
        this.onYourTurn(
          text(event.event_id),
          text(event.transcript),
          text(event.replaces_event_id) || null,
        );
        break;
      case "error": {
        const error = (event.error ?? {}) as Record<string, unknown>;
        // Most session errors are not fatal; show the code and carry on.
        this.notice = `Session notice: ${text(error.code) || "unknown"}`;
        this.emit();
        break;
      }
      default:
        break; // New event types are added over time: ignore what we don't use.
    }
  }

  /**
   * Call when the conversation is over, for any reason. Returns the turns,
   * including an answer that was still being scored.
   */
  finish(): ScoredTurn[] {
    if (this.phase === "ended") return [...this.turns];
    this.phase = "ended";
    if (this.wrapTimer) clearTimeout(this.wrapTimer);
    this.scoreAbort?.abort();
    this.scoring = false;
    const unscored = this.joinedAnswer();
    if (unscored && this.current) {
      this.turns.push({
        questionId: this.current.id,
        question: this.current.text,
        category: this.current.category,
        isFollowUp: this.current.isFollowUp,
        answer: unscored,
        score: null,
      });
    }
    this.answerParts.clear();
    this.emit();
    return [...this.turns];
  }

  // --- opening -------------------------------------------------------------

  private async maybeOpen(): Promise<void> {
    // Nothing may be sent before session.started: it can be lost without an error.
    if (!this.started || !this.presented || this.opened) return;
    this.opened = true;
    const { conversation, plan, role } = this.options;
    const first = plan.questions[0];
    if (!first) {
      this.notice = "The plan has no questions.";
      await this.wrapUp("empty");
      return;
    }
    try {
      const brief = scrubContactDetails(plan.candidate_brief);
      const context = `Background for this practice interview. Role: ${safeLine(role, 200)}.\n${brief}`;
      for (const chunk of toLineChunks(context)) {
        await conversation.append("thinking", chunk);
      }
      this.current = { id: first.id, text: first.text, category: first.category, isFollowUp: false };
      this.askPending = true;
      this.phase = "live";
      // The persona never speaks first: this asks it to open.
      await conversation.sendInterfaceEvent({
        type: "response.create",
        response: {
          instructions: safeLine(
            "Greet the candidate briefly, mention that you are an AI practice interviewer, " +
              `then ask the first question in your own words: "${first.text}"`,
          ),
        },
      });
    } catch (error) {
      this.notice = `Couldn't open the interview: ${(error as Error).message}`;
    }
    this.emit();
  }

  // --- transcript ----------------------------------------------------------

  private onInterviewerReplyDone(): void {
    const said = this.interviewerLive.trim();
    if (said) this.lines.push({ who: "interviewer", text: said });
    this.interviewerLive = "";
    // The question counts as asked once a reply that began after it was sent ends.
    if (this.replyCountsAsAsk && said) this.askPending = false;
    this.replyCountsAsAsk = false;
    this.emit();
  }

  private onYourTurn(eventId: string, transcript: string, replaces: string | null): void {
    const settled = transcript.trim();
    this.youLive = "";
    if (!settled) {
      this.emit();
      return;
    }

    // A later, fuller version of a turn takes the earlier one's place.
    const replacedLine = replaces ? this.answerParts.get(replaces) : undefined;
    if (replaces && replacedLine !== undefined) {
      const at = this.lines.findIndex((line) => line.who === "you" && line.text === replacedLine);
      if (at >= 0) this.lines[at] = { who: "you", text: settled };
      else this.lines.push({ who: "you", text: settled });
    } else {
      this.lines.push({ who: "you", text: settled });
    }

    // Words said before the question has been asked are not an answer to it.
    if (this.phase !== "live" || !this.current || this.askPending) {
      this.emit();
      return;
    }

    if (replaces) this.answerParts.delete(replaces);
    this.answerParts.set(eventId || `turn_${this.answerParts.size}_${Date.now()}`, settled);
    void this.scoreCurrentAnswer();
    this.emit();
  }

  private joinedAnswer(): string {
    return [...this.answerParts.values()].join(" ").trim();
  }

  // --- scoring -------------------------------------------------------------

  private async scoreCurrentAnswer(): Promise<void> {
    const question = this.current;
    const answer = this.joinedAnswer();
    if (!question || !answer) return;

    // A candidate who pauses mid-answer produces two turns: score the whole
    // answer again and drop the stale result.
    const seq = ++this.scoreSeq;
    this.scoreAbort?.abort();
    const abort = new AbortController();
    this.scoreAbort = abort;
    this.scoring = true;
    this.emit();

    const maxFollowUps = this.options.maxFollowUps ?? 1;
    let score: AnswerScore | null = null;
    let failed = false;
    try {
      score = await this.options.score(
        {
          sessionId: this.options.sessionId,
          role: this.options.role,
          question: question.text,
          answer,
          allowFollowUp: this.followUpsUsed < maxFollowUps,
        },
        abort.signal,
      );
    } catch (error) {
      if (abort.signal.aborted) return;
      failed = true;
      this.notice = `Couldn't score that answer (${(error as Error).message}). It was saved unscored.`;
    }
    if (seq !== this.scoreSeq || this.phase !== "live") return;
    this.scoring = false;

    // "Can you repeat that?" is not an answer: the persona handles it itself.
    if (!failed && score && !score.is_answer) {
      this.answerParts.clear();
      this.emit();
      return;
    }

    this.turns.push({
      questionId: question.id,
      question: question.text,
      category: question.category,
      isFollowUp: question.isFollowUp,
      answer,
      score,
    });
    this.answerParts.clear();
    await this.advance(score);
  }

  private async advance(score: AnswerScore | null): Promise<void> {
    const { plan, conversation } = this.options;
    const maxFollowUps = this.options.maxFollowUps ?? 1;
    const planned = plan.questions[this.index];
    const followUp = score?.follow_up?.trim();

    let lead: string;
    if (followUp && planned && this.followUpsUsed < maxFollowUps) {
      this.followUpsUsed += 1;
      this.current = { id: planned.id, text: followUp, category: planned.category, isFollowUp: true };
      lead = "Ask this follow-up next, in your own words";
    } else {
      this.index += 1;
      this.followUpsUsed = 0;
      const next = plan.questions[this.index];
      if (!next) {
        await this.wrapUp("done");
        return;
      }
      this.current = { id: next.id, text: next.text, category: next.category, isFollowUp: false };
      lead = "Move on and ask this next question, in your own words";
    }

    this.askPending = true;
    this.emit();
    try {
      // The persona finishes its acknowledgment, then takes a turn to ask.
      await conversation.append("instructions", safeLine(`${lead}: "${this.current.text}"`));
    } catch (error) {
      this.notice = `Couldn't send the next question: ${(error as Error).message}`;
      this.emit();
    }
  }

  private async wrapUp(why: "done" | "time" | "empty"): Promise<void> {
    if (this.phase === "wrapping" || this.phase === "ended") return;
    this.phase = "wrapping";
    this.current = null;
    this.emit();
    const opener =
      why === "time"
        ? "The session is almost out of time, so the interview is over."
        : "That was the last question, so the interview is over.";
    try {
      await this.options.conversation.append(
        "instructions",
        `${opener} Thank the candidate, tell them their scorecard is on screen now, say goodbye and end the call.`,
      );
    } catch {
      /* the hang-up below still ends it */
    }
    // If the persona doesn't hang up after its goodbye, the page does.
    this.wrapTimer = setTimeout(() => {
      void this.options.conversation.disconnect();
    }, this.options.wrapUpTimeoutMs ?? 25_000);
  }

  private emit(): void {
    this.options.onUpdate(this.snapshot());
  }
}
