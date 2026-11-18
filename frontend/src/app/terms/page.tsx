import type { Metadata } from "next";
import { LegalPage, OPERATOR } from "@/components/app/LegalPage";

export const metadata: Metadata = { title: "Terms · InterviewPilot" };

// A plain-language starting point. Have it reviewed before relying on it.
export default function Terms() {
  return (
    <LegalPage title="Terms of service" updated="November 17, 2026">
      <h2>The service</h2>
      <p>
        InterviewPilot, run by {OPERATOR}, lets you rehearse job interviews with an AI video interviewer and get AI
        feedback on your answers. It is a practice tool. It does not guarantee any interview outcome, and its feedback
        can be wrong.
      </p>

      <h2>Who can use it</h2>
      <p>
        You must be 18 or older and in a region where the video interviewer is offered (currently the US except
        Colorado, Connecticut, Illinois and Texas; the UK; the EU; and Canada except Quebec). Calls with someone who
        appears to be under 18 on camera can end automatically.
      </p>

      <h2>Your account</h2>
      <p>
        Keep access to your email secure: anyone who can open your sign-in links can use your account. One person per
        account.
      </p>

      <h2>Interviews and payment</h2>
      <ul>
        <li>Pay as you go: $1 per interview, bought in advance. Unused interviews don&apos;t expire and can be refunded within 14 days of purchase on request.</li>
        <li>
          Monthly plan: $10 a month, renewing automatically until you cancel. It includes up to 60 interviews per billing
          month (fair use); unused ones don&apos;t carry over. Cancel any time from &quot;Manage plan&quot;: the plan stays
          active until the end of the month you paid for, and there are no refunds for part of a month.
        </li>
        <li>Prices are shown before you pay, and payment is processed by Stripe.</li>
        <li>An interview is used when it starts. If it fails to start, retrying within 35 minutes doesn&apos;t use another one.</li>
        <li>The interviewer service is in preview and can be unavailable or end a call early. If that costs you an interview, contact us and we will restore the credit.</li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        Don&apos;t use InterviewPilot to harass, deceive or impersonate anyone; to upload content you have no right to use;
        or to try to break, overload or reverse-engineer it. Don&apos;t read out ID numbers, card numbers or phone
        numbers during a call: automated safety checks may end it. Calls that break the interviewer provider&apos;s
        acceptable-use policy end automatically, and repeated violations can pause your access.
      </p>

      <h2>Your content</h2>
      <p>
        You keep ownership of your resume, notes and answers. You let us process them only to provide the service, as
        the Privacy page describes. You can delete them at any time from the app.
      </p>

      <h2>Limits</h2>
      <p>
        The service is provided as is. To the extent the law allows, {OPERATOR}&apos;s total liability to you is limited to
        what you paid in the 12 months before the claim.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms; the date above shows when. Continued use after a change means you accept it.</p>
    </LegalPage>
  );
}
