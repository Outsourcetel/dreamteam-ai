// ============================================================
// Reading a model's answer envelope — ONE implementation.
//
// de-answer, widget-ask and specialist-consult each carried their own copy of
// this. The copies were not merely untidy: de-answer had been hardened four
// separate times against real production failures and NONE of the fixes
// reached the others. Most of that matters most in widget-ask, which is the
// embedded widget on a customer's own website.
//
// What the other copies did that this one does not:
//   • returned the model's raw output as the answer when the envelope would
//     not parse, at confidence 50, with needs_escalation FALSE — i.e. handed a
//     visitor the wreckage and marked it safe to send
//   • delivered a "..." answer carrying a self-reported confidence of 98
//   • returned the JSON blob itself when the model quoted its own envelope
//   • lost the whole answer when max_tokens cut the envelope mid-string
//
// The behaviour here is de-answer's, because de-answer's is the one that
// survived contact with production. Every comment below records the incident
// that put the line there — they are not decoration.
// ============================================================

export interface AnswerEnvelope {
  answer: string;
  confidence: number;
  /** The model may name these `sources` or `citations`; both are accepted. */
  sources: string[];
  needs_escalation: boolean;
  /** Only widget-ask asks for this; null everywhere else. */
  language: string | null;
  /** Passed through raw — each caller validates and clamps it. */
  customer_state?: unknown;
}

export interface KDoc {
  id: string;
  title: string;
  content: string;
  tags: string[];
  visibility?: string;
}

// ── Retrieval helpers ────────────────────────────────────────────────────
// These three were byte-identical in behaviour across all three functions;
// sharing them changes nothing today and stops them drifting tomorrow.

export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'for', 'with', 'my', 'i', 'me', 'can', 'you', 'your', 'do', 'does', 'how', 'what',
  'why', 'when', 'where', 'please', 'need', 'want', 'help', 'about', 'it', 'this', 'that',
]);

export function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Keyword rank over candidate docs: title 3, tag 2, body occurrence 1 (capped
 *  at 3). Top 3, and only docs that matched at all. */
export function rankDocs(question: string, docs: KDoc[]): KDoc[] {
  const qTokens = [...new Set(tokenize(question))];
  if (qTokens.length === 0) return docs.slice(0, 3);
  return docs
    .map((d) => {
      const title = tokenize(d.title);
      const body = tokenize(d.content);
      const tags = (d.tags || []).flatMap((t) => tokenize(t));
      let score = 0;
      for (const q of qTokens) {
        if (title.includes(q)) score += 3;
        if (tags.includes(q)) score += 2;
        score += Math.min(3, body.filter((w) => w === q).length);
      }
      return { d, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.d);
}

// ── Salvage ──────────────────────────────────────────────────────────────

/** Recover the "answer" string from MALFORMED or TRUNCATED JSON — a manual
 *  scan with escape handling that tolerates a missing closing quote (the
 *  max_tokens case). Returns clean prose, or null when there is nothing worth
 *  returning. */
export function extractAnswerField(text: string): string | null {
  const m = text.match(/"answer"\s*:\s*"/);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;

  // Find the REAL end of the answer string.
  //
  // The model sometimes writes an unescaped double quote inside the answer —
  // e.g. `sets the run to "waiting_human" until someone decides`. That makes
  // the envelope invalid JSON, which is why we are in the salvage path at all,
  // and stopping at the FIRST unescaped quote cut the answer off exactly where
  // the quoted term began. That is the mid-sentence truncation seen in
  // production: a 423-character answer ending "...sets the run to", while the
  // same question answered in full elsewhere. It had nothing to do with
  // max_tokens — the answer was ~110 tokens against a 1536 ceiling.
  //
  // The closing quote is the last one sitting in a JSON structural position:
  // followed only by whitespace and then a comma, a closing brace, or the end
  // of the text. Inner quotes never satisfy that. If none does, the envelope
  // really was cut off mid-string and we take what is there, as before.
  let limit = text.length;
  for (let k = text.length - 1; k > start; k--) {
    if (text[k] !== '"') continue;
    const rest = text.slice(k + 1).replace(/^\s+/, '');
    if (rest === '' || rest[0] === ',' || rest[0] === '}') { limit = k; break; }
  }

  let i = start;
  let out = '';
  while (i < limit) {
    const c = text[i];
    if (c === '\\') {
      const n = text[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else if (n === 'u') {
        const cp = parseInt(text.slice(i + 2, i + 6), 16);
        if (!Number.isNaN(cp)) out += String.fromCharCode(cp);
        i += 4;
      } else out += n ?? '';
      i += 2;
    } else { out += c; i += 1; }
    // NOTE: no break on '"'. The closing quote is already excluded by `limit`
    // above, so any quote reached here is one the model left unescaped INSIDE
    // the answer — it is content, and breaking on it is exactly what truncated
    // answers mid-sentence.
  }
  const trimmed = out.trim();
  // A salvaged string with no letters or digits is not an answer, it is
  // wreckage. The old floor was `length >= 3`, which let a bare "..." through
  // — and it did: four cert-exam answers to "How do I create a new Digital
  // Employee?" came back as literally three dots, carrying a self-reported
  // confidence of 98. A customer would have been shown an ellipsis by an
  // employee that believed it had answered well.
  if (!/[a-z0-9]/i.test(trimmed)) return null;
  return trimmed.length >= 3 ? trimmed : null;
}

// ── The parser ───────────────────────────────────────────────────────────

export function parseAnswerEnvelope(raw: string, depth = 0): AnswerEnvelope {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      const p = JSON.parse(text.slice(start, end + 1));
      let answer = typeof p.answer === 'string' ? p.answer : raw.trim();

      // Nested envelope (model quoted its own JSON): unwrap ONE level.
      if (depth === 0 && answer.trimStart().startsWith('{') && answer.includes('"answer"')) {
        answer = parseAnswerEnvelope(answer, 1).answer;
      }

      // A well-formed envelope can still carry a non-answer. Four cert-exam
      // answers to "How do I create a new Digital Employee?" came back as
      // literally "..." inside PERFECTLY VALID JSON, with a self-reported
      // confidence of 98 — so the model was sure it had answered, and the
      // parser had no reason to disagree. An empty or punctuation-only answer
      // is a failed generation, not a poor one: escalate rather than deliver,
      // and never let it carry a confidence that says otherwise.
      const degenerate = !/[a-z0-9]/i.test(answer);

      return {
        answer: degenerate ? '' : answer,
        confidence: degenerate ? 0 : Math.max(0, Math.min(100, Math.round(Number(p.confidence)) || 0)),
        // The specialist path names this `citations`; accept either.
        sources: Array.isArray(p.sources) ? p.sources.map(String)
          : Array.isArray(p.citations) ? p.citations.map(String) : [],
        needs_escalation: degenerate || !!p.needs_escalation,
        language: typeof p.language === 'string' && p.language.trim() ? p.language.trim() : null,
        customer_state: p.customer_state,
      };
    } catch { /* fall through to salvage */ }
  }

  // Malformed/TRUNCATED JSON (e.g. max_tokens cut the envelope mid-string,
  // the replay-path bug that leaked raw JSON to the judge): salvage the
  // answer text + whatever scalar fields survive, never return the wreckage.
  const salvaged = extractAnswerField(text);
  if (salvaged) {
    const conf = text.match(/"confidence"\s*:\s*(\d{1,3})/);
    const lang = text.match(/"language"\s*:\s*"([^"]{1,40})"/);
    return {
      answer: salvaged,
      confidence: conf ? Math.max(0, Math.min(100, parseInt(conf[1], 10))) : 50,
      sources: [],
      needs_escalation: /"needs_escalation"\s*:\s*true/.test(text),
      language: lang ? lang[1] : null,
    };
  }

  // Nothing parseable and nothing salvageable. Returning raw.trim() here meant
  // handing the caller whatever wreckage the model produced — malformed JSON,
  // an empty string, an ellipsis — as if it were an answer, with
  // needs_escalation FALSE, i.e. safe to send. A generation we could not read
  // is not a low-quality answer, it is no answer: escalate it to a human
  // rather than deliver it.
  const bare = raw.trim();
  const usable = /[a-z0-9]/i.test(bare) && bare.length >= 12 && !bare.includes('"answer"');
  return {
    answer: usable ? bare : '',
    confidence: 0,
    sources: [],
    needs_escalation: !usable,
    language: null,
  };
}
