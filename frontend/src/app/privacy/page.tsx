import type { Metadata } from "next";
import { LegalPage, OPERATOR } from "@/components/app/LegalPage";

export const metadata: Metadata = { title: "Privacy · InterviewPilot" };

// A plain-language starting point. Have it reviewed before relying on it.
export default function Privacy() {
  return (
    <LegalPage title="Privacy" updated="November 17, 2026">
      <h2>What we store</h2>
      <ul>
        <li>Your email address, to sign you in.</li>
        <li>
          Text from your resume, with email addresses, phone numbers, links and ID-like numbers removed first. The
          resume file itself is not kept.
        </li>
        <li>The role, any job description you add, your &quot;About you&quot; notes, and your interview transcripts and scorecards.</li>
        <li>Your credit balance and purchase records (amount and date; Stripe holds the card details, we never see them).</li>
      </ul>
      <p>
        Resume text, notes, job descriptions and interviews are encrypted before they are written to our database, and
        each account can read only its own records.
      </p>

      <h2>Who processes it</h2>
      <ul>
        <li>
          <strong>Anthropic (Claude)</strong> plans questions, scores answers and writes stronger answers. It receives
          relevant resume passages, your notes, the job description, the questions and your answer transcripts.
        </li>
        <li>
          <strong>Nuance Labs</strong> runs the video interviewer. During a call it receives your microphone audio,
          your camera video only if you turn the camera on, the questions and a short contact-free summary of your
          experience. Nuance records calls and runs safety checks on them under its own terms.
        </li>
        <li>
          <strong>OpenAI</strong> runs the voice-only interviewer, when you choose it or when the video interviewer is
          unavailable. During such a call it receives your microphone audio and the interview questions, under its
          own API terms. No camera video is used.
        </li>
        <li><strong>Supabase</strong> hosts the encrypted database and sends sign-in emails.</li>
        <li><strong>Vercel</strong> hosts the app.</li>
        <li><strong>Stripe</strong> processes payments.</li>
        <li><strong>Firecrawl</strong> reads job-posting links you submit (the link only, not your data).</li>
      </ul>
      <p>We don&apos;t sell your data, show ads, or use analytics trackers.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Use &quot;Delete all my data&quot; in the app to erase your resumes, notes and interviews at once.</li>
        <li>Ask us to delete your account and purchase records too.</li>
        <li>Keep the camera off: the interviewer works without seeing you.</li>
      </ul>

      <h2>Retention</h2>
      <p>
        We keep your data until you delete it or close your account. Purchase records are kept as long as tax and
        accounting rules require.
      </p>

      <p className="ip-muted">{OPERATOR} operates InterviewPilot.</p>
    </LegalPage>
  );
}
