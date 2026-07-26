// ============================================================================
// siteDiscovery — turn ONE website address into a ranked, de-duplicated,
// SSRF-safe list of pages worth putting in a knowledge base.
//
// ── Why this exists ────────────────────────────────────────────────────────
// The two real outside signups both died with ZERO knowledge documents. The
// only URL path we had (LiveKnowledgeLibrary.importUrl -> extract-document,
// kind:'url') imports exactly ONE page per paste. A support team's answers are
// spread across dozens of help/FAQ/policy pages, so "import my website" meant
// pasting URLs one at a time, forever. Nobody did.
//
// This module is the discovery half of the fix. It does NOT create documents:
// index.ts hands the ranked URLs to the existing mig-347 ingestion queue, whose
// worker (knowledge-ingest-drain) already fetches, extracts, de-duplicates,
// chunks and embeds. Adding a second ingestion path would have been the
// two-implementations-of-one-fact mistake mig 350 §3 was careful to avoid.
//
// ── Ranking is the load-bearing part ───────────────────────────────────────
// max_pages cuts the tail, so ORDER decides what the employee can answer.
// The evidence for the weights is the actual transcript that lost the "acs"
// evaluator on 2026-07-24 (four questions in twenty seconds):
//   "charged twice ... how to get a refund"     -> refund / billing / payments
//   "cancelled 45 days ago but still charged"   -> cancellation policy
//   "invoice shows a line item I never signed"  -> invoice / pricing / plans
//   "internet keeps dropping"                   -> troubleshooting / support
// Every one of those is a support/help/policy page. None is a blog post. So
// support-shaped pages rank first and marketing/blog/archive pages rank last.
//
// ── SSRF ───────────────────────────────────────────────────────────────────
// SSRF is a prior incident in this codebase (migs 154, 099). Every fetch here
// goes through isSafeExternalUrl — the same lexical guard the DB CHECK uses —
// AND walks redirects manually so a 302 to http://169.254.169.254/ is refused
// rather than followed. Plain `fetch` defaults to redirect:'follow', which is
// precisely how a validated URL turns into an unvalidated one.
// ============================================================================

import { isSafeExternalUrl } from './urlSafety.ts';
import { browserFetch } from './browserFetch.ts';

// ── Bounds. Every one of these is a "this must not hang the function" limit ──
export const MAX_PAGES_CEILING = 50;      // hard ceiling, whatever the caller asks
export const DEFAULT_MAX_PAGES = 20;
const MAX_REDIRECTS = 5;
const MAX_BYTES_SITEMAP = 8 * 1024 * 1024;  // sitemaps are text; 8MB is ~50k URLs
const MAX_BYTES_HTML = 3 * 1024 * 1024;
const MAX_BYTES_ROBOTS = 512 * 1024;
const MAX_SITEMAP_FILES = 12;             // a sitemapindex can list hundreds
const MAX_CANDIDATES = 4000;              // stop parsing a huge sitemap
const MAX_CRAWL_FETCHES = 8;              // homepage fallback only

export type SkipReason =
  | 'login_or_cart'        // sign-in/checkout — no answers behind an auth wall
  | 'listing_or_archive'   // /tag/, /category/, /page/2, /2024/ — index pages, not content
  | 'not_a_page'           // .png/.css/.zip — nothing readable
  | 'off_site'             // different site than the one the user asked for
  | 'unsafe_address'       // failed the SSRF guard
  | 'already_imported'     // this exact URL is already a document in the library
  | 'over_max_pages';      // ranked below the cut

export interface RankedPage {
  url: string;
  score: number;
  /** plain-language justification, surfaced in the import report */
  why: string;
}
export interface SkippedUrl { url: string; reason: SkipReason }

export interface DiscoveryResult {
  /** the normalised site root actually used */
  site: string;
  /** how the pages were found — degrades sitemap -> robots -> homepage links */
  method: 'sitemap' | 'robots-sitemap' | 'homepage-links' | 'input-only';
  /** total distinct in-scope URLs seen before the max_pages cut */
  found: number;
  ranked: RankedPage[];
  skipped: SkippedUrl[];
  /** non-fatal problems worth telling the human about (e.g. sitemap 404) */
  notes: string[];
}

// ── URL normalisation ───────────────────────────────────────────────────────

/**
 * Accept what a human actually types. A user pasting their own website types
 * "acme.com" or "www.acme.com/", not "https://acme.com". Rejecting that is the
 * kind of friction that produced 0 documents in 16 workspaces.
 * Returns null if it cannot be made into a safe http(s) URL.
 */
export function normalizeInputUrl(raw: string): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  // Strip a pasted "http://" typo'd as "http:/", and any surrounding quotes.
  s = s.replace(/^["'<\s]+|["'>\s]+$/g, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // Reject other schemes explicitly rather than prefixing https:// onto them.
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null;   // mailto:, file:, javascript:
    s = 'https://' + s;
  }
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!u.hostname || !u.hostname.includes('.')) return null;  // "localhost", "intranet"
  u.hash = '';
  const out = u.toString();
  return isSafeExternalUrl(out) ? out : null;
}

// Tracking parameters carry no content and would make the same page look like
// several different ones to the de-duplicator.
const JUNK_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_(c|e)id$|ref$|source$|_ga$|igshid$|si$)/i;

/** Stable key for "is this the same page?". Lowercases host only — paths are
 *  case-sensitive on most servers, so folding them would merge distinct pages. */
export function canonicalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  for (const k of [...u.searchParams.keys()]) if (JUNK_PARAMS.test(k)) u.searchParams.delete(k);
  u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
  u.pathname = u.pathname.replace(/\/index\.(html?|php|aspx?)$/i, '/');
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/**
 * Registrable-domain approximation. The edge runtime has no Public Suffix List,
 * so this is a HEURISTIC: normally the last two labels, but three when the
 * second-to-last is a well-known second-level registry under a 2-letter ccTLD
 * (acme.co.uk, acme.com.au). Wrong only for exotic suffixes, and the failure
 * mode is conservative — we treat a related host as off-site and skip it.
 */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const sld = parts[parts.length - 2];
  const tld = parts[parts.length - 1];
  const KNOWN_SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'in']);
  if (tld.length === 2 && KNOWN_SLD.has(sld) && parts.length >= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** Same site = same registrable domain. Deliberately allows help.acme.com when
 *  the user typed acme.com — a hosted help centre on a subdomain is exactly the
 *  content a support employee needs, and it is the same organisation's site. */
export function sameSite(candidate: string, baseHost: string): boolean {
  try {
    return registrableDomain(new URL(candidate).hostname) === registrableDomain(baseHost);
  } catch { return false; }
}

// ── Ranking ─────────────────────────────────────────────────────────────────

const NON_PAGE_EXT = /\.(jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?|css|js|mjs|json|xml|rss|atom|zip|gz|tar|rar|7z|dmg|exe|msi|pkg|mp[34]|m4[av]|wav|ogg|webm|mov|avi|woff2?|ttf|eot|otf|txt|csv|xlsx?|pptx?|docx?)(\?|$)/i;
const LOGIN_OR_CART = /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|logout|sign-out|password|reset-password|forgot|cart|basket|checkout|my-account|account\/(login|orders)|wp-login|wp-admin|admin|dashboard|portal\/login|auth)(\/|$|\.)/i;
const LISTING_OR_ARCHIVE = /(^|\/)(tag|tags|category|categories|author|archive|archives|page|feed|comments|search|amp)(\/|$)|\/page\/\d+|\/\d{4}\/\d{2}(\/|$)/i;

// Tier weights. The transcript in the header is the evidence for the ordering.
const TIERS: Array<{ re: RegExp; score: number; why: string }> = [
  { re: /(^|[\/_-])(support|help|helpdesk|help-cent(er|re)|faqs?|troubleshoot\w*|knowledge-?base|kb)([\/_-]|$)/i,
    score: 100, why: 'support / help centre' },
  { re: /(^|[\/_-])(refunds?|returns?|cancel\w*|billing|invoices?|payments?|charges?|subscriptions?|warrant(y|ies)|disputes?|chargebacks?)([\/_-]|$)/i,
    score: 95, why: 'billing, refunds or cancellation — what the lost evaluator actually asked about' },
  { re: /(^|[\/_-])(docs?|documentation|guides?|manual|api|how-?tos?|tutorials?|getting-?started|setup|install\w*|onboarding)([\/_-]|$)/i,
    score: 85, why: 'product documentation' },
  { re: /(^|[\/_-])(shipping|delivery|dispatch|tracking|orders?|exchanges?)([\/_-]|$)/i,
    score: 80, why: 'orders, shipping or delivery' },
  { re: /(^|[\/_-])(pricing|prices?|plans?|packages?|tariffs?|rates?)([\/_-]|$)/i,
    score: 75, why: 'pricing' },
  { re: /(^|[\/_-])(terms|tos|terms-of-service|terms-and-conditions|policy|policies|privacy|sla|service-level|legal|gdpr|security|compliance)([\/_-]|$)/i,
    score: 70, why: 'policy or terms' },
  { re: /(^|[\/_-])(contact|contact-us|about|about-us|company|team|locations?|stores?|hours|services?|products?|solutions?|features?|coverage|availability)([\/_-]|$)/i,
    score: 55, why: 'company or service information' },
];
const DEPRIORITISED: Array<{ re: RegExp; penalty: number; why: string }> = [
  { re: /(^|[\/_-])(blog|news|press|newsroom|articles?|insights?|stories|updates?|releases?)([\/_-]|$)/i,
    penalty: 45, why: 'blog or news — rarely what a support answer needs' },
  { re: /(^|[\/_-])(careers?|jobs?|hiring|vacanc\w*|events?|webinars?|case-stud\w*|testimonials?|partners?|investors?|media)([\/_-]|$)/i,
    penalty: 40, why: 'marketing or recruitment page' },
];

/**
 * Score a candidate. Returns a skip reason instead of a score when the page
 * cannot usefully be a knowledge document at all.
 */
export function scorePage(rawUrl: string, baseHost: string): { skip: SkipReason } | RankedPage {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return { skip: 'not_a_page' }; }
  if (!isSafeExternalUrl(rawUrl)) return { skip: 'unsafe_address' };
  if (!sameSite(rawUrl, baseHost)) return { skip: 'off_site' };

  const path = u.pathname;
  const isPdf = /\.pdf(\?|$)/i.test(path);

  if (!isPdf && NON_PAGE_EXT.test(path)) return { skip: 'not_a_page' };

  // MEASURED, not guessed. Running discovery against the founder's own site
  // (outsourcetel.com, 2026-07-26) returned 13 pages of which EVERY ONE scored
  // the generic 30 — including /about.html and /AccountingBilling.html — because
  // the tier patterns need a word boundary that ".html" and CamelCase do not
  // provide. Two normalisations fix it:
  //   · drop the page extension, so "about.html" reads as "about"
  //   · split CamelCase, so "AccountingBilling" reads as "Accounting-Billing"
  // Static .html sites and CamelCase filenames are exactly what a small
  // business's website looks like — i.e. the sites this feature exists for.
  const stem = path.replace(/\.(html?|php|aspx?|jsp|jspx|shtml|cfm)$/i, '');
  const matchable = stem.replace(/([a-z0-9])([A-Z])/g, '$1-$2');

  if (LOGIN_OR_CART.test(matchable)) return { skip: 'login_or_cart' };
  if (LISTING_OR_ARCHIVE.test(matchable + u.search)) return { skip: 'listing_or_archive' };

  // Homepage: not support content, but it states what the business actually
  // does — which is the one thing every answer needs and no other page states.
  if (path === '/' || path === '') {
    return { url: rawUrl, score: 90, why: 'home page — states what the business does' };
  }

  let score = 30;
  let why = 'general page';
  for (const t of TIERS) {
    if (t.re.test(matchable)) { score = t.score; why = t.why; break; }
  }
  for (const d of DEPRIORITISED) {
    if (!d.re.test(matchable)) continue;
    // CAPPED, not merely subtracted. Measured on plausible.io (2026-07-26):
    // a plain subtraction left /blog/backlinks-seo-guide at 40 — above real
    // pages like /dpa and /tools at 30 — because the word "guide" in a blog
    // slug earned the documentation tier. With max_pages=20 that lets blog
    // posts crowd out the terms, pricing and contact pages a support employee
    // actually needs. The cap keeps blog content importable when there is
    // room, but never ahead of a genuine page.
    score = Math.min(score - d.penalty, 25);
    why = d.why;
    break;
  }

  // A linked PDF is usually a policy, price list or manual — high-value, and
  // the ingest worker already reads PDFs (knowledge-ingest-drain:119).
  if (isPdf) { score += 10; why += ' (PDF)'; }

  // Shallower pages are the canonical ones; deep paths are long-tail detail.
  const depth = path.split('/').filter(Boolean).length;
  score -= Math.min(12, Math.max(0, depth - 2) * 3);
  // A query string usually means a filtered/parameterised view of another page.
  if (u.search) score -= 8;

  return { url: rawUrl, score, why };
}

/**
 * A readable document title derived from the URL.
 *
 * WHY this is needed rather than letting the worker do it: knowledge-ingest-drain
 * resolveContent() (lines 131-146) calls stripHtml() FIRST and only then runs
 * /<title>...<\/title>/ over the RESULT — but stripHtml has already removed every
 * tag, so that regex can never match and the title always falls back to the raw
 * URL. A library of 20 documents named "https://acme.com/help/refund-policy" is
 * a library nobody browses. Passing an explicit title bypasses that entirely.
 *
 * Deterministic on purpose: the same URL always yields the same title, so the
 * worker's title+content hash dedupe still recognises a re-import.
 */
export function titleFromUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { return raw.slice(0, 200); }
  const host = u.hostname.replace(/^www\./i, '');
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return host;

  let slug: string;
  try { slug = decodeURIComponent(segs[segs.length - 1]); } catch { slug = segs[segs.length - 1]; }
  slug = slug
    .replace(/\.(html?|php|aspx?|jsp|jspx|shtml|cfm|pdf)$/i, '')
    .replace(/[-_+.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')   // CamelCase filenames, as on outsourcetel.com
    .replace(/\s+/g, ' ')
    .trim();
  if (!slug) return host;

  const MINOR = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
  // /faq and /api are two of the most common paths on a support site; "Faq"
  // and "Api" in a document list read as a bug to the person browsing it.
  const ACRONYM = new Set(['api', 'faq', 'faqs', 'sla', 'sso', 'kb', 'tos', 'dpa', 'gdpr', 'hipaa', 'pci', 'ccpa', 'hr', 'it', 'eu', 'us', 'uk', 'pdf', 'crm', 'seo', 'b2b', 'b2c', 'ai']);
  const titled = slug.split(' ').map((w, i) => {
    if (ACRONYM.has(w.toLowerCase())) return w.toUpperCase();
    if (i > 0 && MINOR.has(w.toLowerCase())) return w.toLowerCase();
    if (/[A-Z]/.test(w.slice(1))) return w;                    // already styled (SaaS, API)
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(' ');

  // The section prefix is what makes 20 near-identical help slugs tellable
  // apart in a list ("Help · Refund Policy" vs just "Refund Policy").
  const parent = segs.length > 1 ? segs[segs.length - 2] : '';
  const prefix = parent && parent.length <= 20 && !/^\d+$/.test(parent)
    ? parent.replace(/[-_+.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) + ' · '
    : '';
  return `${prefix}${titled}`.slice(0, 300);
}

// ── Parsers (pure — unit-testable without a network) ────────────────────────

/** Pull <loc> values, and tell the caller whether this was a sitemap INDEX. */
export function parseSitemap(xml: string): { isIndex: boolean; locs: string[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && locs.length < MAX_CANDIDATES) {
    const v = decodeXmlEntities(m[1].trim());
    if (v) locs.push(v);
  }
  return { isIndex, locs };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}

/** robots.txt "Sitemap:" directives. Case-insensitive per the de-facto spec. */
export function parseRobotsSitemaps(txt: string): string[] {
  const out: string[] = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Absolute hrefs from an HTML document, resolved against its own URL. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < MAX_CANDIDATES) {
    const href = decodeXmlEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    try { out.push(new URL(href, baseUrl).toString()); } catch { /* unparseable href */ }
  }
  return out;
}

// ── SSRF-safe fetching ──────────────────────────────────────────────────────

// browserFetch does not export its header set and this module may not edit it,
// so this is a deliberately smaller mirror: enough to get past naive UA checks
// on the discovery hops. The real bot-wall handling still comes from
// browserFetch, which safeFetchText falls back to on 403/429/503.
const DISCOVERY_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export interface TextFetch {
  ok: boolean;
  status: number;
  text?: string;
  contentType?: string;
  finalUrl?: string;
  detail?: string;
  /** true when the byte cap cut the body short */
  truncated?: boolean;
}

/** Read a response body with a hard byte cap, so a 4GB file cannot be buffered. */
async function readCapped(resp: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(resp.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    try { await resp.body?.cancel(); } catch { /* already consumed */ }
    return { text: '', truncated: true };
  }
  if (!resp.body) return { text: await resp.text(), truncated: false };
  const reader = resp.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) { parts.push(value.slice(0, value.byteLength - (total - maxBytes))); truncated = true; break; }
    parts.push(value);
  }
  try { await reader.cancel(); } catch { /* stream already closed */ }
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(buf), truncated };
}

/**
 * Fetch text with the SSRF guard applied to EVERY hop.
 *
 * Redirects are walked with redirect:'manual' rather than left to the runtime.
 * This is the whole point: `fetch` defaults to redirect:'follow', so a URL that
 * passed isSafeExternalUrl can still land on http://169.254.169.254/ via a 302.
 * Each Location is resolved, re-validated, and refused if it fails.
 *
 * On 403/429/503 it hands the (already validated) final URL to browserFetch for
 * its full browser header set, backoff, and the optional RENDER_FETCH_URL
 * escape hatch. RESIDUAL RISK, stated rather than hidden: that fallback call
 * uses redirect:'follow' internally, so an origin that answers 403 on the first
 * request and 302-to-a-private-address on the retry would not be caught here.
 * Fixing it properly means exporting a manual-redirect mode from browserFetch,
 * which this task may not edit.
 */
export async function safeFetchText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; deadline?: number } = {},
): Promise<TextFetch> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const maxBytes = opts.maxBytes ?? MAX_BYTES_HTML;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (opts.deadline && Date.now() > opts.deadline) {
      return { ok: false, status: 0, detail: 'ran out of time before this page could be fetched' };
    }
    if (!isSafeExternalUrl(current)) {
      return { ok: false, status: 0, detail: `refused: ${current} is not a permitted external address` };
    }
    let resp: Response;
    try {
      resp = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: DISCOVERY_HEADERS,
      });
    } catch (e) {
      return { ok: false, status: 0, detail: `could not reach it (${String((e as Error)?.message ?? e).slice(0, 120)})` };
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      try { await resp.body?.cancel(); } catch { /* no body */ }
      if (!loc) return { ok: false, status: resp.status, detail: `redirect with no destination (HTTP ${resp.status})` };
      let next: string;
      try { next = new URL(loc, current).toString(); } catch {
        return { ok: false, status: resp.status, detail: 'redirect destination could not be understood' };
      }
      if (!/^https?:/i.test(next) || !isSafeExternalUrl(next)) {
        // The exact case the brief calls out. Refuse loudly, do not follow.
        return { ok: false, status: resp.status, detail: `refused a redirect to a non-public address (${next.slice(0, 80)})` };
      }
      current = next;
      continue;
    }

    if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
      try { await resp.body?.cancel(); } catch { /* no body */ }
      const out = await browserFetch(current, timeoutMs, 2);
      if (!out.ok || !out.response) {
        return { ok: false, status: out.status, detail: out.detail ?? `HTTP ${out.status}` };
      }
      const body = await readCapped(out.response, maxBytes);
      return {
        ok: true, status: out.response.status, text: body.text, truncated: body.truncated,
        contentType: (out.response.headers.get('content-type') ?? '').toLowerCase(), finalUrl: current,
      };
    }

    if (!resp.ok) {
      try { await resp.body?.cancel(); } catch { /* no body */ }
      return { ok: false, status: resp.status, detail: `HTTP ${resp.status}` };
    }

    const body = await readCapped(resp, maxBytes);
    return {
      ok: true, status: resp.status, text: body.text, truncated: body.truncated,
      contentType: (resp.headers.get('content-type') ?? '').toLowerCase(), finalUrl: current,
    };
  }
  return { ok: false, status: 0, detail: `too many redirects (over ${MAX_REDIRECTS})` };
}

// ── Discovery ───────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  maxPages?: number;
  /** absolute epoch-ms budget for the whole discovery phase */
  deadline?: number;
  /** canonical URLs already in the library — skipped as 'already_imported' */
  alreadyImported?: Set<string>;
}

/**
 * Discover pages for one site: sitemap.xml -> sitemapindex (one level) ->
 * robots.txt Sitemap: -> homepage links. Each step is only attempted if the
 * previous one produced nothing, so a site with a good sitemap costs 1 fetch.
 */
export async function discoverSitePages(inputUrl: string, opts: DiscoverOptions = {}): Promise<DiscoveryResult | { error: string }> {
  const site = normalizeInputUrl(inputUrl);
  if (!site) return { error: 'that does not look like a public website address' };

  const maxPages = Math.min(MAX_PAGES_CEILING, Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES));
  const deadline = opts.deadline ?? Date.now() + 60_000;
  const base = new URL(site);
  const baseHost = base.hostname;
  const root = `${base.protocol}//${base.host}`;
  const notes: string[] = [];

  const candidates = new Set<string>();
  let method: DiscoveryResult['method'] = 'input-only';

  // ── (a) /sitemap.xml, following a <sitemapindex> ONE level down ──────────
  const sitemapQueue: string[] = [`${root}/sitemap.xml`];
  const seenSitemaps = new Set<string>();
  let indexFollowed = false;

  const drainSitemaps = async (): Promise<void> => {
    while (sitemapQueue.length && seenSitemaps.size < MAX_SITEMAP_FILES && Date.now() < deadline) {
      const sm = sitemapQueue.shift()!;
      if (seenSitemaps.has(sm)) continue;
      seenSitemaps.add(sm);
      // A sitemap hosted off-site cannot be trusted to describe this site.
      if (!sameSite(sm, baseHost)) { notes.push(`ignored an off-site sitemap: ${sm.slice(0, 100)}`); continue; }
      if (/\.gz(\?|$)/i.test(sm)) {
        // Honest gap rather than an unverified DecompressionStream path.
        notes.push(`skipped a gzipped sitemap (${sm.slice(0, 80)}) — compressed sitemaps are not read yet`);
        continue;
      }
      const r = await safeFetchText(sm, { timeoutMs: 12000, maxBytes: MAX_BYTES_SITEMAP, deadline });
      if (!r.ok || !r.text) { notes.push(`${sm.replace(root, '') || sm}: ${r.detail ?? 'no content'}`); continue; }
      if (r.truncated) notes.push(`${sm.slice(0, 80)} was larger than the read limit — only the first part was used`);
      // MEASURED: basecamp.com/sitemap.xml (2026-07-26) lists 171 RELATIVE
      // paths ("/about", "/help") rather than the absolute URLs the sitemap
      // spec requires. Before resolving them against the sitemap's own URL,
      // every one failed `new URL(loc)` and was discarded as "not a page" —
      // basecamp.com yielded exactly ONE importable page instead of 171.
      // Real sitemaps are not spec-clean; resolve, do not assume.
      const resolveAgainst = r.finalUrl ?? sm;
      const abs = (loc: string): string | null => {
        try { return new URL(loc, resolveAgainst).toString(); } catch { return null; }
      };

      const parsed = parseSitemap(r.text);
      if (parsed.isIndex) {
        if (indexFollowed) continue;         // one level down only, per the brief
        indexFollowed = true;
        for (const loc of parsed.locs.slice(0, MAX_SITEMAP_FILES)) {
          const a = abs(loc);
          if (a) sitemapQueue.push(a);
        }
        continue;
      }
      for (const loc of parsed.locs) {
        if (candidates.size >= MAX_CANDIDATES) break;
        const a = abs(loc);
        if (a) candidates.add(a);
      }
    }
  };

  await drainSitemaps();
  if (candidates.size > 0) method = 'sitemap';

  // ── (b) robots.txt Sitemap: directives ──────────────────────────────────
  if (candidates.size === 0 && Date.now() < deadline) {
    const robots = await safeFetchText(`${root}/robots.txt`, { timeoutMs: 8000, maxBytes: MAX_BYTES_ROBOTS, deadline });
    if (robots.ok && robots.text) {
      const declared = parseRobotsSitemaps(robots.text);
      if (declared.length === 0) notes.push('robots.txt named no sitemap');
      for (const s of declared.slice(0, MAX_SITEMAP_FILES)) {
        try { sitemapQueue.push(new URL(s, root).toString()); } catch { /* unparseable directive */ }
      }
      indexFollowed = false;                 // allow one index level from here too
      await drainSitemaps();
      if (candidates.size > 0) method = 'robots-sitemap';
    } else {
      notes.push(`robots.txt: ${robots.detail ?? 'not available'}`);
    }
  }

  // ── (c) fallback: crawl the homepage for same-site links ────────────────
  // Bounded BFS, depth 2. Depth 1 alone usually yields only the top nav; the
  // actual FAQ articles are one click further in (a /support hub linking to
  // its articles), which is exactly the content that answers a support question.
  if (candidates.size === 0) {
    const visited = new Set<string>();
    let frontier: string[] = [site];
    let fetches = 0;
    for (let depth = 0; depth < 2 && frontier.length && Date.now() < deadline; depth++) {
      const next: string[] = [];
      for (const pageUrl of frontier) {
        if (fetches >= MAX_CRAWL_FETCHES || Date.now() > deadline) break;
        const key = canonicalizeUrl(pageUrl);
        if (!key || visited.has(key)) continue;
        visited.add(key);
        fetches++;
        const r = await safeFetchText(pageUrl, { timeoutMs: 12000, maxBytes: MAX_BYTES_HTML, deadline });
        if (!r.ok || !r.text) { notes.push(`${pageUrl.slice(0, 80)}: ${r.detail ?? 'no content'}`); continue; }
        if (!(r.contentType ?? '').includes('html') && r.contentType) continue;
        candidates.add(r.finalUrl ?? pageUrl);
        for (const link of extractLinks(r.text, r.finalUrl ?? pageUrl)) {
          if (candidates.size >= MAX_CANDIDATES) break;
          if (!sameSite(link, baseHost)) continue;
          candidates.add(link);
          // Only follow the promising hubs to depth 2, never everything.
          const s = scorePage(link, baseHost);
          if ('score' in s && s.score >= 80) next.push(link);
        }
      }
      frontier = next.slice(0, MAX_CRAWL_FETCHES);
    }
    if (candidates.size > 0) method = 'homepage-links';
  }

  // The site root is always worth having, whatever discovery found.
  candidates.add(site);

  // ── Rank, de-duplicate, cut ─────────────────────────────────────────────
  const skipped: SkippedUrl[] = [];
  const byKey = new Map<string, RankedPage>();
  for (const raw of candidates) {
    const key = canonicalizeUrl(raw);
    if (!key) { skipped.push({ url: raw, reason: 'not_a_page' }); continue; }
    if (byKey.has(key)) continue;                    // same page, different spelling
    if (opts.alreadyImported?.has(key)) { skipped.push({ url: key, reason: 'already_imported' }); continue; }
    const scored = scorePage(key, baseHost);
    if ('skip' in scored) { skipped.push({ url: key, reason: scored.skip }); continue; }
    byKey.set(key, scored);
  }

  const all = [...byKey.values()].sort((a, b) =>
    b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url));
  const ranked = all.slice(0, maxPages);
  for (const cut of all.slice(maxPages)) skipped.push({ url: cut.url, reason: 'over_max_pages' });

  return { site, method, found: all.length, ranked, skipped, notes };
}
