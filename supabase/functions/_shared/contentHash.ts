// _shared/contentHash.ts — one place both ingest paths (ingest-chunks and
// connector-hub) compute a BYTE-IDENTICAL content hash, so "unchanged" means the
// same thing everywhere (WS8 skip-if-unchanged, mig 286).
//
// Normalization collapses only presentation, never meaning: NFC unicode, CRLF→LF,
// collapse runs of spaces/tabs and blank lines, trim. Words, casing, and
// punctuation are preserved — so reformatting/whitespace edits do NOT force a
// re-embed, but a real content change DOES.

export function normalizeContent(s: string): string {
  return (s ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')        // CRLF / CR → LF
    .replace(/[ \t]+/g, ' ')         // collapse horizontal whitespace runs
    .replace(/ *\n */g, '\n')        // trim spaces around newlines
    .replace(/\n{3,}/g, '\n\n')      // collapse 3+ blank lines to one
    .trim();
}

/** sha256 hex of the normalized text (Web Crypto — no pgcrypto dependency). */
export async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalizeContent(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
