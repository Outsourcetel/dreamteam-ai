// ============================================================
// extract-document — turns a PDF or a web page into plain text the
// knowledge pipeline can ingest. Removes the "text/markdown only"
// friction wall: a real customer's FAQs live in PDFs and on help-center
// URLs, not .txt files.
//
// It ONLY extracts + returns text — no DB writes. The caller then uses
// the existing, proven createKnowledgeDoc + ingestDocChunks path, so
// chunking/embedding/scoping are unchanged. Auth is verify_jwt (any
// logged-in user); no tenant resolution needed since nothing is stored.
//
// PDF text extraction uses unpdf (a serverless-friendly pdf.js build).
// URL fetches pass the shared SSRF guard.
// ============================================================
import { extractText, getDocumentProxy } from 'https://esm.sh/unpdf@0.12.1';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';
import { browserFetch } from '../_shared/browserFetch.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_TEXT_CHARS = 500_000;         // cap what we hand back to the ingester

function stripHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return (Array.isArray(text) ? text.join('\n\n') : String(text ?? '')).trim();
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64; // tolerate data: URLs
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind ?? '');

    if (kind === 'pdf') {
      if (typeof body.file_base64 !== 'string' || !body.file_base64) {
        return json({ error: 'file_base64 required for a PDF' }, 400);
      }
      let bytes: Uint8Array;
      try { bytes = decodeBase64(body.file_base64); }
      catch { return json({ error: 'could not decode the file' }, 400); }
      if (bytes.length > MAX_PDF_BYTES) return json({ error: `PDF too large (max ${MAX_PDF_BYTES / 1024 / 1024} MB)` }, 413);
      let text: string;
      try { text = await pdfToText(bytes); }
      catch (e) { return json({ error: `could not read this PDF (${String((e as Error)?.message ?? e).slice(0, 120)}) — it may be scanned/image-only, which needs OCR (not supported yet)` }, 422); }
      if (!text) return json({ error: 'no selectable text found — this PDF is likely scanned images (OCR not supported yet)' }, 422);
      const title = String(body.filename ?? 'Document').replace(/\.pdf$/i, '');
      return json({ title, text: text.slice(0, MAX_TEXT_CHARS), chars: text.length });
    }

    if (kind === 'url') {
      const url = String(body.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return json({ error: 'a full http(s) URL is required' }, 400);
      if (!isSafeExternalUrl(url)) return json({ error: 'that URL is blocked by the safety policy (internal/private addresses are not allowed)' }, 400);
      // Browser-like headers + retry/backoff on transient bot walls (403/429/503).
      const outcome = await browserFetch(url, 15000, 3);
      if (!outcome.ok || !outcome.response) {
        return json({ error: outcome.detail ?? `that URL returned HTTP ${outcome.status}`, reason: outcome.reason ?? 'server_error' }, 422);
      }
      const resp = outcome.response;
      const ctype = resp.headers.get('content-type') ?? '';
      let text: string;
      if (ctype.includes('application/pdf')) {
        const buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.length > MAX_PDF_BYTES) return json({ error: 'linked PDF too large' }, 413);
        try { text = await pdfToText(buf); } catch { text = ''; }
      } else {
        text = stripHtml((await resp.text()).slice(0, 2_000_000));
      }
      if (!text) return json({ error: 'no readable text found at that URL' }, 422);
      const title = String(body.title ?? '').trim() || url.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 120);
      return json({ title, text: text.slice(0, MAX_TEXT_CHARS), chars: text.length, source_url: url });
    }

    return json({ error: 'kind must be "pdf" or "url"' }, 400);
  } catch (e) {
    return json({ error: `extraction failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` }, 500);
  }
});
