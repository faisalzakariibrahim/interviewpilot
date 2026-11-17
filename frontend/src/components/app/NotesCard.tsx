"use client";

// "About you" notes: facts that are true but not on the resume, such as who
// actually employs you. Claude treats them as evidence when planning and
// scoring, so they stop being flagged as "not backed by your resume".

import { useEffect, useState } from "react";
import { getNotes, saveNotes } from "@/lib/face-to-face/api";

const LIMIT = 2000;

export function NotesCard({ ready }: { ready: boolean }) {
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ready || loaded) return;
    let cancelled = false;
    getNotes()
      .then((text) => {
        if (cancelled) return;
        setNotes(text);
        setSaved(text);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setStatus("Couldn't load your notes.");
      });
    return () => {
      cancelled = true;
    };
  }, [ready, loaded]);

  async function save() {
    setBusy(true);
    setStatus(null);
    try {
      const stored = await saveNotes(notes);
      setNotes(stored);
      setSaved(stored);
      setStatus(stored !== notes.trim() ? "Saved. Contact details were removed." : "Saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Couldn't save your notes.");
    } finally {
      setBusy(false);
    }
  }

  const changed = notes !== saved;

  return (
    <section className="ip-card" aria-labelledby="notes-title">
      <h2 id="notes-title">About you</h2>
      <p className="ip-muted" style={{ margin: 0 }}>
        True things that aren&apos;t on your resume. Claude uses them when it plans questions and scores
        answers, so they stop being flagged. Contact details are removed when you save.
      </p>
      <label className="ip-field">
        <span>Notes</span>
        <textarea
          className="ip-textarea"
          value={notes}
          maxLength={LIMIT}
          disabled={!loaded}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={"For example: I'm a Loss Prevention Officer with Metro One, posted at H&M in Manhattan.\nI've handled detentions with NYPD and write incident reports for store management."}
        />
      </label>
      <div className="ip-row" style={{ marginTop: 12 }}>
        <button type="button" className="ip-primary" disabled={!loaded || busy || !changed} onClick={() => void save()}>
          {busy ? "Saving" : "Save notes"}
        </button>
        <span className="ip-muted">
          {notes.length} / {LIMIT}
          {status ? ` · ${status}` : changed ? " · unsaved changes" : ""}
        </span>
      </div>
    </section>
  );
}
