# InterviewPilot: face-to-face mock interviews

Practise a job interview with a video AI interviewer. It asks questions built from your
resume, listens to your answers, asks one follow-up when an answer is thin, and gives you a
scorecard at the end.

This is a standalone build of the face-to-face mode. It runs on your own computer.

## Start it

Double-click **`Start InterviewPilot.command`**.

The first run installs everything (a few minutes), then opens the app in your browser.
After that it starts in seconds. Keep the Terminal window open while you practise.
Press Ctrl-C in that window to stop.

From a terminal: `./start.sh`

### You need

- Node.js 20.9 or newer, and Python 3.9 or newer.
- An **Anthropic API key** from https://console.anthropic.com/settings/keys
  Paste it into `backend/.env` after `ANTHROPIC_API_KEY=`.
- A **Nuance Labs API key** from https://platform.nuancelabs.ai (accept the developer
  agreement there first). Paste it into `frontend/.env.local` after `NUANCE_API_KEY=`.

The launcher creates both files and opens them for you on the first run. You can paste the
keys while the app is running; the page picks them up within a few seconds.

## Features

- Face-to-face mock interview with a Nuance video interviewer (opt-in, with a disclosure).
- Questions planned from your resume, job posting and "About you" notes; each answer scored by Claude, with one follow-up.
- "Show a stronger answer": a rewrite of your own answer in situation-action-result form, with [brackets] where a fact is missing. Nothing invented.
- "About you" notes: true facts not on your resume, used as evidence so they stop being flagged.
- Progress: average score per interview over time, and by question type.
- "Delete all my data".

## Cloud version (optional)

The same app can run on Vercel with Supabase, for use from any device:

1. Create a Supabase project and run `supabase/schema.sql`, then add your email:
   `insert into public.ip_allowed_emails values ('you@example.com');`
2. Put your Supabase URL and anon key at the top of `deploy-cloud.sh`.
3. Run `./deploy-cloud.sh`. It signs in to Vercel, creates two projects (backend + web app),
   copies your keys from `backend/.env` and `frontend/.env.local` into Vercel as write-only
   secrets, generates `DATA_ENCRYPTION_KEY` (kept in `.cloud-encryption-key`, git-ignored), and deploys.
4. In Supabase → Authentication → URL Configuration, set Site URL and a Redirect URL to the web app's address.

Cloud privacy: sign-in is limited to allowlisted emails (checked by the backend and again by
row-level security in Postgres); resumes, notes and interviews are AES-256-GCM encrypted before
they reach the database, with a key the database never holds; the backend uses each user's own
token, never a service-role key. Back up `.cloud-encryption-key`: without it the cloud data can't be read.

## Where your data goes

| Stays on this computer | Goes to Claude (Anthropic) | Goes to Nuance Labs, only during a call |
| --- | --- | --- |
| Resume passages and the search index (`backend/data/`) | Resume passages with contact details removed | Microphone audio |
| Scorecards and history (your browser's localStorage) | The job description, the questions, your answer transcripts | Camera video, only if you switch it on |
| Your API keys (`backend/.env`, `frontend/.env.local`) | | The questions and a short contact-free summary of your experience |

- Emails, phone numbers, links and ID-like numbers are stripped when the resume is uploaded,
  before anything is stored or sent.
- The uploaded file itself is never saved. "Remove resume and start over" deletes the stored passages.
- Face-to-face mode is opt-in: nothing connects to Nuance until you accept the disclosure in the app.
- Both servers listen on `127.0.0.1` only. Next.js telemetry is switched off by the launcher.
- Nuance records calls and runs safety checks on them. Their terms apply to that data.

## How a session runs

1. You enter a role, upload a resume (PDF, DOCX, TXT or MD) and optionally paste the job posting.
2. Claude plans the questions from your resume and the posting.
3. The interviewer appears and asks question 1. Each answer's transcript is scored on your
   machine's backend by Claude, which may suggest one follow-up.
4. After the last question the interviewer says goodbye and the scorecard appears.

## Limits to know about

- English only. Nuance's beta isn't offered in CO, CT, IL or TX, or outside the US, EU, UK and Canada.
- Nuance's API is a preview: a call can be refused when capacity is short, or end early.
- Don't read out phone, card or ID numbers during a call. A safety check can end it.
- If you pause so long that the next question has already been sent, the rest of that answer isn't scored.
- Resume search uses keyword vectors in FAISS (NumPy if FAISS can't be installed). There is no
  embedding model, which is fine for a resume. To use one, replace `embed()` in
  `backend/app/resume_store.py`.

## Layout

```
Start InterviewPilot.command   double-click launcher
start.sh                       installs, starts both parts, opens the page
backend/                       FastAPI: resume parsing, local index, plan + score with Claude
  app/main.py
  app/resume_parser.py         PDF / DOCX / TXT to text
  app/resume_store.py          passages, vectors, FAISS search, saved under backend/data/
  app/routers/sessions.py      POST/GET/DELETE /api/sessions
  app/routers/face_to_face.py  POST /api/face-to-face/plan and /score
  app/stores/                  local files or Supabase (encrypted)
  tests/                       43 tests
frontend/                      Next.js 16 + React 19
  src/app/page.tsx             setup, interview, history
  src/app/api/nuance-token/    mints one-use Nuance session tokens; the key stays server-side
  src/components/face-to-face/ disclosure, call screen, scorecard
  src/lib/face-to-face/        director (interview logic), SDK hook, store, scrubbing, personas
  tests/                       13 tests
.logs/                         backend.log and frontend.log from the last run
```

## Tests

```
cd backend && .venv/bin/python -m pip install -r requirements-dev.txt && .venv/bin/python -m pytest
cd frontend && npm test && npm run typecheck
./start.sh --check             # starts both parts, confirms they answer, stops
```

## Settings

| Variable | Where | What |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | `backend/.env` | Required. Plans and scores. |
| `F2F_MODEL` | `backend/.env` | Optional. Default `claude-sonnet-5-5`. A faster model shortens the gap between questions. |
| `NUANCE_API_KEY` | `frontend/.env.local` | Required for calls. |
| `INTERVIEWPILOT_PORT`, `INTERVIEWPILOT_BACKEND_PORT` | shell | Optional. Defaults 3000 and 8000; the next free port is used if taken. |

## First real call: what to watch

Everything except a live Nuance call has been tested. On your first call, check that the
interviewer waits for the next question after acknowledging an answer. If it makes up its own
questions, tighten the wording in `frontend/src/lib/face-to-face/personas.ts`.

## Moving this into the full InterviewPilot app

The face-to-face module is self-contained: copy `frontend/src/lib/face-to-face/`,
`frontend/src/components/face-to-face/`, `frontend/src/app/api/nuance-token/` and
`backend/app/routers/face_to_face.py`. Pass your own FAISS search to
`build_face_to_face_router(retrieve, ...)` in place of `resume_store`.
