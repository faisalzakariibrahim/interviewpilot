import { test } from "node:test";
import assert from "node:assert/strict";
import { InterviewDirector, type DirectorConversation, type ScoreFn } from "../src/lib/face-to-face/director";
import type { AnswerScore, InterviewPlan } from "../src/lib/face-to-face/api";

const plan: InterviewPlan = {
  candidate_brief: "Loss prevention officer, CySA+. Reach at 201-555-0142 or a@b.co.",
  questions: [
    { id: "q1", text: "Tell me about a time you handled an incident.", category: "behavioral" },
    { id: "q2", text: "How do you triage alerts?", category: "technical" },
  ],
};

function fake() {
  const sent: Array<{ kind: string; content: string }> = [];
  let disconnected = 0;
  const conversation: DirectorConversation = {
    async append(kind, content) { sent.push({ kind, content }); },
    async sendInterfaceEvent(event) {
      const r = (event.response ?? {}) as { instructions?: string };
      sent.push({ kind: String(event.type), content: r.instructions ?? "" });
    },
    async disconnect() { disconnected += 1; },
  };
  return { sent, conversation, disconnects: () => disconnected };
}

const score = (over: Partial<AnswerScore> = {}): AnswerScore => ({
  is_answer: true, score: 7, strengths: ["clear"], improvements: [], not_in_resume: [], follow_up: null, ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 5));

function personaSays(d: InterviewDirector, words: string) {
  d.handleInterfaceEvent({ type: "session.output_transcript.delta", delta: words });
  d.handleInterfaceEvent({ type: "session.output_audio.done", reason: "completed" });
}
function youSay(d: InterviewDirector, id: string, transcript: string, replaces?: string) {
  d.handleInterfaceEvent({ type: "session.input_transcript.done", event_id: id, transcript, replaces_event_id: replaces });
}

test("sends nothing before session.started, then briefs and opens", async () => {
  const f = fake();
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "GSOC Analyst", score: async () => score(), onUpdate: () => {} });
  d.handlePresented();
  await tick();
  assert.equal(f.sent.length, 0);
  d.handleInterfaceEvent({ type: "session.started" });
  await tick();
  assert.equal(f.sent[0]!.kind, "thinking");
  assert.ok(!/555|@/.test(f.sent[0]!.content), "brief is scrubbed");
  assert.equal(f.sent.at(-1)!.kind, "response.create");
  assert.ok(f.sent.at(-1)!.content.includes("handled an incident"));
  assert.equal(d.snapshot().phase, "live");
});

test("full run: follow-up once, next question, wrap up, hang-up fallback", async () => {
  const f = fake();
  const calls: Array<{ question: string; answer: string; allowFollowUp: boolean }> = [];
  const results = [score({ follow_up: "What was your specific role?" }), score({ score: 8, follow_up: "ignored: no follow-ups left" }), score({ score: 9 })];
  const scoreFn: ScoreFn = async (input) => { calls.push(input); return results[calls.length - 1]!; };
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: scoreFn, onUpdate: () => {}, wrapUpTimeoutMs: 10 });
  d.handleInterfaceEvent({ type: "session.started" });
  d.handlePresented();
  await tick();

  youSay(d, "e0", "hi, can you hear me?"); // before the question is asked: ignored
  await tick();
  assert.equal(calls.length, 0);

  personaSays(d, "Hi, I'm an AI practice interviewer. Tell me about an incident.");
  youSay(d, "e1", "We had a shoplifting ring and I coordinated the response.");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.allowFollowUp, true);
  assert.ok(f.sent.at(-1)!.content.includes("follow-up") && f.sent.at(-1)!.content.includes("specific role"));

  personaSays(d, "Thanks."); // ack that began before the ask counted? it began after: treat next reply as the ask
  personaSays(d, "What was your specific role?");
  youSay(d, "e2", "I led the floor team and wrote the report.");
  await tick();
  assert.equal(calls[1]!.allowFollowUp, false);
  assert.ok(f.sent.at(-1)!.content.includes("triage alerts"));
  assert.equal(d.snapshot().questionNumber, 2);

  personaSays(d, "How do you triage alerts?");
  youSay(d, "e3", "Severity first, then asset criticality.");
  await tick();
  assert.equal(d.snapshot().phase, "wrapping");
  assert.ok(f.sent.at(-1)!.content.includes("end the call"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(f.disconnects(), 1);

  const turns = d.finish();
  assert.deepEqual(turns.map((t) => [t.questionId, t.isFollowUp, t.score?.score]), [["q1", false, 7], ["q1", true, 8], ["q2", false, 9]]);
});

test("a clarification is not scored as an answer and does not advance", async () => {
  const f = fake();
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: async () => score({ is_answer: false }), onUpdate: () => {} });
  d.handleInterfaceEvent({ type: "session.started" }); d.handlePresented(); await tick();
  personaSays(d, "Tell me about an incident.");
  const before = f.sent.length;
  youSay(d, "e1", "Sorry, could you repeat that?");
  await tick();
  assert.equal(f.sent.length, before);
  assert.equal(d.snapshot().turns.length, 0);
  assert.equal(d.snapshot().questionNumber, 1);
});

test("a paused answer is rescored whole and the stale score dropped", async () => {
  const f = fake();
  const answers: string[] = [];
  const scoreFn: ScoreFn = async (input) => { answers.push(input.answer); await new Promise((r) => setTimeout(r, 20)); return score(); };
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: scoreFn, onUpdate: () => {} });
  d.handleInterfaceEvent({ type: "session.started" }); d.handlePresented(); await tick();
  personaSays(d, "Tell me about an incident.");
  youSay(d, "e1", "First half");
  youSay(d, "e2", "second half.");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(answers, ["First half", "First half second half."]);
  assert.equal(d.snapshot().turns.length, 1);
  assert.equal(d.snapshot().turns[0]!.answer, "First half second half.");
});

test("a replacing transcript takes the earlier turn's place", async () => {
  const f = fake();
  const answers: string[] = [];
  const scoreFn: ScoreFn = async (input) => { answers.push(input.answer); await new Promise((r) => setTimeout(r, 20)); return score(); };
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: scoreFn, onUpdate: () => {} });
  d.handleInterfaceEvent({ type: "session.started" }); d.handlePresented(); await tick();
  personaSays(d, "Q?");
  youSay(d, "e1", "I triage");
  youSay(d, "e2", "I triage by severity.", "e1");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(answers.at(-1), "I triage by severity.");
  assert.equal(d.snapshot().lines.filter((l) => l.who === "you").length, 1);
});

test("scoring failure keeps the answer unscored and moves on", async () => {
  const f = fake();
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: async () => { throw new Error("backend down"); }, onUpdate: () => {} });
  d.handleInterfaceEvent({ type: "session.started" }); d.handlePresented(); await tick();
  personaSays(d, "Q1?");
  youSay(d, "e1", "An answer.");
  await tick();
  assert.equal(d.snapshot().turns[0]!.score, null);
  assert.ok(f.sent.at(-1)!.content.includes("triage alerts"));
  assert.ok(d.snapshot().notice?.includes("backend down"));
});

test("hanging up mid-answer keeps the unscored answer", async () => {
  const f = fake();
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: () => new Promise(() => {}), onUpdate: () => {} });
  d.handleInterfaceEvent({ type: "session.started" }); d.handlePresented(); await tick();
  personaSays(d, "Q1?");
  youSay(d, "e1", "Half an answer");
  const turns = d.finish();
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.score, null);
});

test("low time remaining wraps up", async () => {
  const f = fake();
  const d = new InterviewDirector({ ...f, plan, sessionId: "s", role: "r", score: async () => score(), onUpdate: () => {}, wrapUpTimeoutMs: 5 });
  d.handleInterfaceEvent({ type: "session.started" }); d.handlePresented(); await tick();
  d.handleTimeRemaining(45);
  await tick();
  assert.equal(d.snapshot().phase, "wrapping");
  assert.ok(f.sent.at(-1)!.content.includes("out of time"));
  d.finish();
});
