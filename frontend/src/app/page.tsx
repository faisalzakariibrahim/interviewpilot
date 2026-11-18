"use client";

// InterviewPilot's single page: set up a practice session (role + resume),
// run a face-to-face mock interview, and review progress and past scorecards.

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { NotesCard } from "@/components/app/NotesCard";
import { ProgressPanel } from "@/components/app/ProgressPanel";
import { Landing } from "@/components/app/Landing";
import { Pricing } from "@/components/app/Pricing";
import { FaceToFaceInterview, Scorecard } from "@/components/face-to-face/FaceToFaceInterview";
import { CLOUD, signOut, useAuth } from "@/lib/auth";
import {
  clearInterviews,
  createSession,
  deleteAllMyData,
  deleteSession,
  fetchJob,
  getBillingStatus,
  openBillingPortal,
  getHealth,
  getSession,
  listInterviews,
  saveInterview,
  type BackendHealth,
  type BillingStatus,
} from "@/lib/face-to-face/api";
import { useFaceToFaceStore, type FaceToFaceResult } from "@/lib/face-to-face/store";

type Check<T> = { state: "checking" } | { state: "ready"; value: T };

function useSetupStatus(enabled: boolean) {
  const [backend, setBackend] = useState<Check<BackendHealth | null>>({ state: "checking" });
  const [nuance, setNuance] = useState<Check<boolean>>({ state: "checking" });

  const refresh = useCallback(async () => {
    const [health, configured] = await Promise.all([
      getHealth(),
      fetch("/api/nuance-token", { cache: "no-store" })
        .then(async (response) => ((await response.json()) as { configured?: boolean }).configured === true)
        .catch(() => false),
    ]);
    setBackend({ state: "ready", value: health });
    setNuance({ state: "ready", value: configured });
  }, []);

  const allSet =
    backend.state === "ready" && backend.value?.claude_configured === true && nuance.state === "ready" && nuance.value;

  // Keep checking while something is missing, so the banners clear on their
  // own a few seconds after a key is pasted in or the backend comes up.
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    if (allSet) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [allSet, enabled, refresh]);

  return { backend, nuance };
}

/** Interview history from the backend, plus a one-time move of history kept in this browser by older versions. */
function useHistory(ready: boolean) {
  const [items, setItems] = useState<FaceToFaceResult[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const legacy = useFaceToFaceStore((state) => state.results);
  const clearLegacy = useFaceToFaceStore((state) => state.clearLegacyResults);

  const reload = useCallback(async () => {
    try {
      setItems(await listInterviews());
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Couldn't load your history.");
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void (async () => {
      // Local mode only: in the cloud, nothing is uploaded without the person doing it.
      if (!CLOUD && legacy.length) {
        try {
          for (const result of legacy) await saveInterview(result);
          clearLegacy();
        } catch {
          /* try again next load */
        }
      }
      await reload();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const upsert = useCallback((result: FaceToFaceResult) => {
    setItems((current) => {
      const rest = (current ?? []).filter((item) => item.id !== result.id);
      return [result, ...rest].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    });
  }, []);

  return { items: items ?? [], loaded: items !== null, problem, reload, upsert, setItems };
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function Home() {
  const auth = useAuth();
  const signedIn = auth.status === "local" || auth.status === "signed-in";
  const store = useFaceToFaceStore();
  const { backend, nuance } = useSetupStatus(signedIn);

  // Settings come from localStorage: render only in the browser, after it is read.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [role, setRole] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [jobUrl, setJobUrl] = useState("");
  const [jobBusy, setJobBusy] = useState(false);
  const [jobNote, setJobNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const backendUp = backend.state === "ready" && backend.value !== null;
  const claudeReady = backend.state === "ready" && backend.value?.claude_configured === true;
  const nuanceReady = nuance.state === "ready" && nuance.value;
  const history = useHistory(mounted && signedIn && backendUp);

  // Paid mode: the credit balance, refreshed after a purchase or a started interview.
  const paid = CLOUD && backend.state === "ready" && backend.value?.billing === true;
  const [balance, setBalance] = useState<BillingStatus | null>(null);
  const [checkoutNote, setCheckoutNote] = useState<string | null>(null);
  const [showPacks, setShowPacks] = useState(false);
  const refreshBalance = useCallback(async () => {
    try {
      setBalance(await getBillingStatus());
    } catch {
      /* shown as unknown */
    }
  }, []);
  useEffect(() => {
    if (!mounted || !signedIn || !paid) return;
    void refreshBalance();
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("checkout");
    if (outcome) {
      setCheckoutNote(
        outcome === "success"
          ? "Payment received. Your interviews will appear in a few seconds."
          : "Checkout was cancelled. Nothing was charged.",
      );
      window.history.replaceState(null, "", window.location.pathname);
      if (outcome === "success") {
        // The credit arrives through Stripe's webhook, usually within seconds.
        const timers = [2000, 5000, 10000].map((ms) => setTimeout(() => void refreshBalance(), ms));
        return () => timers.forEach(clearTimeout);
      }
    }
  }, [mounted, signedIn, paid, refreshBalance]);
  const planOpen = Boolean(balance?.plan?.active && balance.plan.used < balance.plan.limit);
  const outOfCredits = paid && balance !== null && !balance.unlimited && !planOpen && balance.credits < 1;
  const [portalBusy, setPortalBusy] = useState(false);
  async function managePlan() {
    setPortalBusy(true);
    try {
      window.location.assign(await openBillingPortal());
    } catch (error) {
      setCheckoutNote(error instanceof Error ? error.message : "Couldn't open plan settings.");
      setPortalBusy(false);
    }
  }

  // The backend may have lost the remembered session: check it still exists there.
  const sessionId = store.session?.id ?? null;
  const setSession = store.setSession;
  useEffect(() => {
    if (!mounted || !signedIn || !sessionId || !backendUp) return;
    let cancelled = false;
    void getSession(sessionId).then((found) => {
      if (!cancelled && found === null) setSession(null);
    });
    return () => {
      cancelled = true;
    };
  }, [mounted, signedIn, sessionId, backendUp, setSession]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const resume = fileInput.current?.files?.[0];
    if (!resume) {
      setFormError("Choose your resume file.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      store.setSession(await createSession({ role: role.trim(), jobDescription, resume }));
      setJobDescription("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Couldn't set up the session.");
    } finally {
      setBusy(false);
    }
  }

  async function readJobLink() {
    if (!jobUrl.trim()) return;
    setJobBusy(true);
    setJobNote(null);
    try {
      const posting = await fetchJob(jobUrl.trim());
      setRole(posting.role);
      setJobDescription(posting.job_description);
      const where = [posting.company, posting.location].filter(Boolean).join(" · ");
      setJobNote(`Filled in from the posting${where ? `: ${where}` : ""}. Check it, then continue.`);
    } catch (error) {
      setJobNote(error instanceof Error ? error.message : "Couldn't read that link. Paste the description instead.");
    } finally {
      setJobBusy(false);
    }
  }

  async function removeSession() {
    if (!store.session) return;
    const gone = store.session;
    store.setSession(null);
    setRole(gone.role);
    await deleteSession(gone.id).catch(() => undefined);
  }

  async function onClearHistory() {
    if (!window.confirm("Delete all past interviews and scorecards? This can't be undone.")) return;
    try {
      await clearInterviews();
      history.setItems([]);
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Couldn't clear your history.");
    }
  }

  async function onDeleteEverything() {
    const where = CLOUD ? "from the cloud database" : "from this computer";
    if (
      !window.confirm(
        `Delete everything InterviewPilot stores about you ${where}: resumes, notes and all interview history? This can't be undone.`,
      )
    )
      return;
    try {
      await deleteAllMyData();
      store.setSession(null);
      store.clearLegacyResults();
      history.setItems([]);
      setAccountMessage("Everything was deleted.");
    } catch (error) {
      setAccountMessage(error instanceof Error ? error.message : "Couldn't delete your data.");
    }
  }

  if (!mounted || auth.status === "loading") return null;

  if (auth.status === "signed-out") {
    return (
      <main className="ip-shell">
        <header className="ip-header">
          <h1>InterviewPilot</h1>
        </header>
        <Landing />
      </main>
    );
  }

  const blockedReason = !backendUp
    ? "The InterviewPilot backend isn't running."
    : !claudeReady
      ? CLOUD
        ? "This server is missing its Anthropic key."
        : "Add your Anthropic API key first (see above)."
      : !nuanceReady
        ? CLOUD
          ? "This server is missing its Nuance key."
          : "Add your Nuance API key first (see above)."
        : outOfCredits
          ? balance?.plan?.active
            ? "You've used this month's plan interviews. They reset when your plan renews."
            : "You've used your free interview. Subscribe below to keep practising."
          : null;

  return (
    <main className="ip-shell">
      <header className="ip-header">
        <h1>InterviewPilot</h1>
        {auth.status === "signed-in" ? (
          <span className="ip-row" style={{ gap: 8 }}>
            <span className="ip-tag">{auth.email}</span>
            <button type="button" className="ip-ghost" onClick={() => void signOut()}>
              Sign out
            </button>
          </span>
        ) : (
          <span className="ip-tag">Runs on this computer</span>
        )}
      </header>

      <div className="ip-status" aria-label="Setup status">
        <span>
          <span className={`ip-dot ${backendUp ? "is-ok" : ""}`} />
          Backend {backend.state === "checking" ? "checking" : backendUp ? "running" : "not reachable"}
        </span>
        <span>
          <span className={`ip-dot ${claudeReady ? "is-ok" : ""}`} />
          Claude key {claudeReady ? "set" : "missing"}
        </span>
        <span>
          <span className={`ip-dot ${nuanceReady ? "is-ok" : ""}`} />
          Nuance key {nuanceReady ? "set" : "missing"}
        </span>
        {backendUp && backend.value?.vector_index && (
          <span>Resume search: {backend.value.vector_index.toUpperCase()}, local</span>
        )}
        {CLOUD && backendUp && <span>Your data is encrypted and visible only to you</span>}
      </div>

      {backend.state === "ready" && !backendUp && (
        <div className="ip-banner is-alert" role="alert">
          <strong>The backend isn&apos;t reachable.</strong>
          {CLOUD ? (
            "Try again in a minute."
          ) : (
            <>
              Start the app with <code>Start InterviewPilot.command</code> so both parts come up together.
            </>
          )}
        </div>
      )}
      {!CLOUD && backendUp && !claudeReady && (
        <div className="ip-banner">
          <strong>Add your Anthropic API key.</strong>
          Open <code>backend/.env</code>, paste the key after <code>ANTHROPIC_API_KEY=</code> and save. This
          page picks it up within a few seconds. Claude plans the questions and scores your answers.
        </div>
      )}
      {!CLOUD && nuance.state === "ready" && !nuanceReady && (
        <div className="ip-banner">
          <strong>Add your Nuance API key.</strong>
          Create a key at{" "}
          <a href="https://platform.nuancelabs.ai" target="_blank" rel="noreferrer">
            platform.nuancelabs.ai
          </a>
          , open <code>frontend/.env.local</code>, paste it after <code>NUANCE_API_KEY=</code> and save. It
          powers the video interviewer.
        </div>
      )}

      {paid && (
        <section className="ip-card" aria-labelledby="balance-title">
          <div className="ip-row" style={{ justifyContent: "space-between" }}>
            <h2 id="balance-title" style={{ margin: 0 }}>
              {balance === null
                ? "Interviews"
                : balance.unlimited
                  ? "Unlimited interviews (owner)"
                  : balance.plan?.active
                    ? `Monthly plan: ${Math.max(balance.plan.limit - balance.plan.used, 0)} of ${balance.plan.limit} left this month`
                    : balance.credits > 0
                      ? `${balance.credits} free interview${balance.credits === 1 ? "" : "s"} left`
                      : "No interviews left"}
            </h2>
            <div className="ip-row" style={{ gap: 8 }}>
              {balance?.plan && (
                <button type="button" className="ip-ghost" onClick={() => void managePlan()} disabled={portalBusy}>
                  {portalBusy ? "Opening" : "Manage plan"}
                </button>
              )}
              {balance && !balance.unlimited && !balance.plan?.active && !outOfCredits && (
                <button type="button" className="ip-primary" onClick={() => setShowPacks((v) => !v)}>
                  {showPacks ? "Hide" : "Subscribe"}
                </button>
              )}
            </div>
          </div>
          {balance?.plan?.active && (
            <p className="ip-muted">
              {balance.credits > 0 ? `Plus ${balance.credits} free interview${balance.credits === 1 ? "" : "s"}. ` : ""}
              {balance.plan.cancel_at_period_end ? "Ends" : "Renews"} {new Date(balance.plan.renews_at).toLocaleDateString()}.
            </p>
          )}
          {balance?.plan && !balance.plan.active && (
            <p className="ip-muted">Your monthly plan isn&apos;t active ({balance.plan.status.replace(/_/g, " ")}).</p>
          )}
          {checkoutNote && <p className="ip-muted">{checkoutNote}</p>}
          {balance && !balance.unlimited && !balance.plan?.active && (outOfCredits || showPacks) && (
            <div style={{ marginTop: 12 }}>
              <Pricing canBuy compact hideMonthly={Boolean(balance.plan?.active)} />
            </div>
          )}
        </section>
      )}

      {store.session ? (
        <>
          <section className="ip-card">
            <div className="ip-row" style={{ justifyContent: "space-between" }}>
              <div>
                <h2>{store.session.role}</h2>
                <p className="ip-muted" style={{ margin: 0 }}>
                  {store.session.filename} · {store.session.passage_count} passage
                  {store.session.passage_count === 1 ? "" : "s"} indexed
                  {CLOUD ? ", encrypted" : " on this computer"}
                  {store.session.has_job_description ? " · job description added" : ""}
                </p>
              </div>
              <div className="ip-row">
                <label className="ip-row" style={{ gap: 8 }}>
                  <span className="ip-muted">Questions</span>
                  <select
                    className="ip-select"
                    value={store.questionCount}
                    onChange={(event) => store.setQuestionCount(Number(event.target.value))}
                  >
                    {[3, 5, 7].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="ip-ghost" onClick={() => void removeSession()}>
                  Remove resume and start over
                </button>
              </div>
            </div>
          </section>

          <FaceToFaceInterview
            key={store.session.id}
            sessionId={store.session.id}
            role={store.session.role}
            questionCount={store.questionCount}
            blockedReason={blockedReason}
            onFinished={(result, saved) => (saved ? history.upsert(result) : undefined)}
            paid={paid}
            onCreditSpent={() => void refreshBalance()}
          />
        </>
      ) : (
        <section className="ip-card">
          <h2>Set up a practice interview</h2>
          <p className="ip-muted" style={{ margin: 0 }}>
            {CLOUD
              ? "Your resume is read on the server, email addresses, phone numbers and links are removed, and the passages are stored encrypted so only you can read them. The file itself isn't kept."
              : "Your resume is read and indexed on this computer, and email addresses, phone numbers and links are removed before it is stored."}{" "}
            To plan questions and score answers, the relevant passages go to Claude.
          </p>
          <div className="ip-field">
            <span style={{ fontWeight: 600, fontSize: 14 }}>Job link (optional)</span>
            <div className="ip-row" style={{ flexWrap: "nowrap" }}>
              <input
                className="ip-input"
                type="url"
                inputMode="url"
                value={jobUrl}
                onChange={(event) => setJobUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void readJobLink();
                  }
                }}
                placeholder="https://careers.example.com/jobs/gsoc-analyst"
                aria-label="Job posting link"
              />
              <button type="button" className="ip-ghost" disabled={jobBusy || !jobUrl.trim() || !backendUp} onClick={() => void readJobLink()}>
                {jobBusy ? "Reading" : "Use this posting"}
              </button>
            </div>
            {jobNote && <span className="ip-muted">{jobNote}</span>}
          </div>
          <form onSubmit={(event) => void onSubmit(event)}>
            <label className="ip-field">
              <span>Role you&apos;re interviewing for</span>
              <input
                className="ip-input"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                placeholder="GSOC Analyst"
                required
                minLength={2}
                maxLength={200}
              />
            </label>
            <label className="ip-field">
              <span>Resume (PDF, DOCX, TXT or MD, up to 4 MB)</span>
              <input ref={fileInput} className="ip-input" type="file" accept=".pdf,.docx,.txt,.md" required />
            </label>
            <label className="ip-field">
              <span>Job description (optional)</span>
              <textarea
                className="ip-textarea"
                value={jobDescription}
                onChange={(event) => setJobDescription(event.target.value)}
                placeholder="Paste the posting to get questions tailored to it."
                maxLength={20000}
              />
            </label>
            {formError && (
              <p className="ip-banner is-alert" role="alert" style={{ marginTop: 16 }}>
                {formError}
              </p>
            )}
            <div className="ip-row" style={{ marginTop: 20 }}>
              <button type="submit" className="ip-primary" disabled={busy || !backendUp}>
                {busy ? "Reading your resume" : "Continue"}
              </button>
              {!backendUp && backend.state === "ready" && <span className="ip-muted">Waiting for the backend.</span>}
            </div>
          </form>
        </section>
      )}

      {backendUp && <NotesCard ready={backendUp} />}

      <ProgressPanel results={history.items} />

      {history.items.length > 0 && (
        <section className="ip-card ip-history">
          <div className="ip-row" style={{ justifyContent: "space-between" }}>
            <h2>Past interviews</h2>
            <button type="button" className="ip-ghost" onClick={() => void onClearHistory()}>
              Clear history
            </button>
          </div>
          <p className="ip-muted" style={{ marginTop: 0 }}>
            {CLOUD ? "Stored encrypted; only you can read it." : "Stored on this computer."} Open one to see its
            scorecard or ask for a stronger answer.
          </p>
          {history.items.map((result) => (
            <details key={`${result.id}-${result.startedAt}`}>
              <summary>
                {formatWhen(result.startedAt)} · {result.role} ·{" "}
                {result.average !== null ? `${result.average} / 10` : "not scored"} · {result.turns.length} answer
                {result.turns.length === 1 ? "" : "s"}
              </summary>
              <Scorecard result={result} onChange={history.upsert} />
            </details>
          ))}
        </section>
      )}
      {history.problem && <p className="ip-muted">{history.problem}</p>}

      {CLOUD && (
        <footer className="ip-muted" style={{ display: "flex", gap: 16, margin: "0 0 20px" }}>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
        </footer>
      )}

      {backendUp && (
        <section className="ip-card">
          <h2>Your data</h2>
          <p className="ip-muted" style={{ marginTop: 0 }}>
            {CLOUD
              ? "Resumes, notes and history are encrypted in the database, readable only through your sign-in. The resume file itself is never kept."
              : "Resumes, notes and history are kept in backend/data on this computer. The resume file itself is never kept."}
          </p>
          <button type="button" className="ip-ghost" onClick={() => void onDeleteEverything()}>
            Delete all my data
          </button>
          {accountMessage && <p className="ip-muted">{accountMessage}</p>}
        </section>
      )}
    </main>
  );
}
