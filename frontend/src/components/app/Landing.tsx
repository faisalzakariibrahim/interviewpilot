"use client";

// What people see before signing in to the cloud version.

import Link from "next/link";
import { Pricing } from "./Pricing";

const STEPS = [
  {
    title: "Bring your resume and the job",
    body: "Upload your resume and paste a job link. Questions are built from what you've actually done and what the role asks for.",
  },
  {
    title: "Interview face to face",
    body: "A video AI interviewer asks the questions, listens, and follows up when an answer is thin, like a real hiring manager.",
  },
  {
    title: "Get a scorecard",
    body: "Every answer is scored, with what worked, what to tighten, and a stronger version built only from your own experience.",
  },
];

export function Landing() {
  return (
    <>
      <section style={{ padding: "24px 0 8px" }}>
        <h2 style={{ fontSize: 34, lineHeight: 1.15, margin: "0 0 12px", letterSpacing: "-0.02em" }}>
          Practise your next job interview face to face.
        </h2>
        <p style={{ fontSize: 18, color: "var(--ip-muted)", margin: 0, maxWidth: 640 }}>
          A video AI interviewer asks questions built from your resume and the job you want, then scores every
          answer and shows you how to say it better.
        </p>
        <div className="ip-row" style={{ gap: 12, marginTop: 20, flexWrap: "wrap" }}>
          <Link href="/signup" className="ip-primary ip-cta">Sign up free</Link>
          <Link href="/login" className="ip-ghost ip-cta">Log in</Link>
        </div>
        <p className="ip-muted" style={{ fontSize: 14, marginBottom: 0 }}>Your first 3 interviews are free. No card needed.</p>
      </section>

      <section className="ip-card" style={{ marginTop: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 20 }}>
          {STEPS.map((step, i) => (
            <div key={step.title}>
              <p className="ip-muted" style={{ margin: 0 }}>Step {i + 1}</p>
              <h3 style={{ margin: "4px 0 6px", fontSize: 17 }}>{step.title}</h3>
              <p className="ip-muted" style={{ margin: 0 }}>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="ip-card">
        <h2>Pricing</h2>
        <p className="ip-muted" style={{ marginTop: 0 }}>Your first 3 interviews are free. After that, subscribe monthly; cancel any time.</p>
        <Pricing canBuy={false} />
      </section>

      <section className="ip-card" style={{ textAlign: "center" }}>
        <h2 style={{ marginTop: 0 }}>Ready for your next interview?</h2>
        <p className="ip-muted">Create an account in under a minute and practise your first 3 interviews free.</p>
        <Link href="/signup" className="ip-primary ip-cta">Create a free account</Link>
        <p style={{ marginBottom: 0 }}>
          Already have one? <Link href="/login">Log in</Link>
        </p>
      </section>

      <section className="ip-card">
        <h2>Your data</h2>
        <ul className="ip-muted" style={{ margin: 0, paddingLeft: 20 }}>
          <li>Your resume, notes and scorecards are encrypted and visible only to your account.</li>
          <li>Email addresses, phone numbers and links are removed from your resume before it&apos;s stored.</li>
          <li>The resume file itself isn&apos;t kept. You can delete everything at any time.</li>
          <li>During a call, your audio (and camera, only if you turn it on) goes to our video-interviewer provider.</li>
        </ul>
      </section>

      <footer className="ip-muted" style={{ display: "flex", gap: 16, marginTop: 24 }}>
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <span>For adults (18+) in the US, UK, EU and Canada.</span>
      </footer>
    </>
  );
}
