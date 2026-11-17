// Everything that leaves this machine for Nuance goes through here first.
//
// Two reasons:
// 1. Privacy: the interviewer needs your experience, never your contact details.
// 2. Reliability: Nuance's safety checks can end a session when a phone number
//    shows up in text handed to the persona, so numbers are removed up front.

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
// +233 24 123 4567, +44 (0)20 7946 0958, +971-50-123-4567
const PHONE_INTERNATIONAL = /\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}/g;
// (201) 555-0142, 201-555-0142, 201.555.0142, 1 201 555 0142
const PHONE_NANP = /(?:\b1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
// Any bare run of 9 to 15 digits: 2015550142, 233241234567
const LONG_DIGIT_RUN = /\b\d{9,15}\b/g;

/** Removes contact details and ID-like numbers. Date ranges such as 2019-2024 are kept. */
export function scrubContactDetails(text: string): string {
  return text
    .replace(EMAIL, "[email removed]")
    .replace(URL, "[link removed]")
    .replace(SSN, "[number removed]")
    .replace(PHONE_INTERNATIONAL, "[phone removed]")
    .replace(PHONE_NANP, "[phone removed]")
    .replace(LONG_DIGIT_RUN, "[number removed]")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** True when text still holds something scrubContactDetails would remove. */
export function hasContactDetails(text: string): boolean {
  return scrubContactDetails(text) !== text.replace(/[ \t]{2,}/g, " ").trim();
}

/** Nuance caps an append and a response.create note at 2,000 characters. */
export const NUANCE_LINE_LIMIT = 2000;

/**
 * Splits text into pieces that each fit one Nuance line, breaking at paragraph,
 * then sentence, then word boundaries.
 */
export function toLineChunks(text: string, limit = NUANCE_LINE_LIMIT - 100): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const chunks: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit * 0.4) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("\n"));
    if (cut < limit * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = limit - 1;
    chunks.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** One line, scrubbed and cut to fit: for a question or a short note. */
export function safeLine(text: string, limit = NUANCE_LINE_LIMIT - 100): string {
  const clean = scrubContactDetails(text).replace(/\s+/g, " ");
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).trimEnd()}…`;
}
