// ============================================================
// Turning fetched content into text worth embedding — one implementation.
//
// stripHtml existed in four functions in three variants, chunkText in two, and
// parseJsonLoose in two. As with the answer helpers, the copies were not equal:
//
//   connector-hub's stripHtml removed only the TAGS. It never stripped the
//   CONTENTS of <script> or <style>, so raw JavaScript and CSS were ingested
//   as article text — on the Zendesk, Salesforce Knowledge and Confluence
//   paths, i.e. straight into the knowledge base and then into embeddings.
//
//   connector-hub's chunkText broke only on '\n\n', '. ' and ' ', against a
//   fixed threshold. ingest-chunks' recognised '!', '?' and '.\n' too, scaled
//   its threshold to the chunk size, and kept the full stop WITH its sentence.
//   Chunk boundaries decide what retrieval can find, so the weaker splitter
//   quietly produced worse answers from connector-sourced documents.
//
// The better implementation wins in both cases.
// ============================================================

// ── HTML → text ──────────────────────────────────────────────────────────

/** Strip markup to readable text. Removes script/style/comment CONTENT (not
 *  just their tags), turns block-level closers into newlines, and decodes the
 *  handful of entities that actually show up. */
export function stripHtml(raw: string): string {
  return (raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-line variant for places that want a snippet rather than a document —
 *  same stripping, but all whitespace collapsed. */
export function stripHtmlInline(raw: string): string {
  return stripHtml(raw).replace(/\s+/g, ' ').trim();
}

// ── Chunking ─────────────────────────────────────────────────────────────

export const CHUNK_SIZE = 1500;    // chars
export const CHUNK_OVERLAP = 200;  // chars

/** Split text into overlapping chunks, preferring to break at a paragraph,
 *  then a sentence end, then a space — searched backwards from the limit so a
 *  chunk ends on a natural boundary rather than mid-word. */
export function chunkText(text: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const clean = (text || '').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(
        window.lastIndexOf('. '), window.lastIndexOf('.\n'),
        window.lastIndexOf('! '), window.lastIndexOf('? '),
      );
      const space = window.lastIndexOf(' ');
      // Thresholds scale with the chunk size, so a caller passing a different
      // size still gets sensible breaks. `sentence + 1` keeps the full stop
      // with the sentence it ends.
      const cut = para > size * 0.4 ? para
        : sentence > size * 0.4 ? sentence + 1
        : space > size * 0.4 ? space
        : window.length;
      end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// ── Loose JSON ───────────────────────────────────────────────────────────

/** Pull the first {...} span out of a model reply and parse it. Returns null
 *  rather than throwing — every caller treats unparseable output as "no
 *  result", not as an exception. */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
