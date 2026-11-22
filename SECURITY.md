# InterviewPilot security notes

How the hosted app is protected, and the risks that are accepted on purpose.

## Accounts and data
- Sign-in: Supabase (email + password with confirmation, Google, or a one-time email link). Passwords need at least 8 characters with letters and digits, enforced by Supabase itself.
- Every user-data table has row-level security: an account reads and writes only its own rows. Billing, grants, admins and usage tables are not reachable through the public API at all.
- Resumes, notes, job descriptions and scorecards are encrypted by the backend before storage. Contact details are removed from resumes before indexing.
- Database limits that also hold for direct API writes: per-value size checks, at most 50 resume sessions and 2,000 scorecards per account.
- The admin page is checked in the database (`is_admin`), not just in the page.

## Paid features and cost control
- Every interview runs under a server-issued grant. Planning, scoring, stronger answers and video/voice calls are counted against it. Interviews that never connect are refunded automatically.
- Fair use, enforced in the database: 3 free interviews per account, 15 a month on the plan, and at most 3 interviews started per account in any 24 hours (admins exempt).
- Usage alert: when interviews started in 24 hours reach `alert_24h` (default 40), /admin shows a warning and the backend emails the admins once a day (needs SMTP_USER/SMTP_PASSWORD on the backend).
- Provider keys (Claude, OpenAI, Nuance, Stripe, Supabase service role) stay on the servers. The browser never sees them. Calls to OpenAI and Nuance carry an opaque per-user id, never an email.

## Web app
- Content-Security-Policy (scripts and styles from this site only, no framing, forms post only here), HSTS, nosniff, no referrer, camera/microphone for this site only.
- The interviewer routes accept calls only from this site's own pages, only signed in, only with consent and a valid grant.
- Job links: only public internet addresses (every redirect re-checked), at most 2 MB read.
- Stripe webhooks are signature-checked. Prices, months and currency are verified before a plan is recorded.

## Accepted risks (decided by the owner)
- **Leaked-password check is off.** Supabase offers it only on the Pro plan. Mitigated by the password-strength rules above.
- **The 20-minute call limit is enforced by the browser.** A modified page could keep a voice call open until OpenAI's own 60-minute stop. Mitigated by the 3-a-day limit and by a monthly spend cap in the OpenAI dashboard (owner to set). Nuance applies its own per-account maximum to video calls.
- **Payments are in Stripe test mode** until the owner switches to live keys.

## Checking it again
- `cd backend && python3 -m pytest -q`; `cd frontend && npx tsc --noEmit && npm audit --omit=dev`
- Supabase dashboard → Advisors → Security (only the leaked-password item is expected).
