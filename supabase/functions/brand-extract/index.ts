/**
 * brand-extract — per-tenant brand identity, phase 1 (spec:
 * docs/superpowers/specs/2026-08-10-tenant-brand-identity-design.md).
 *
 * The owner/admin pastes their company website URL and this function drafts
 * the brand identity spec — palette, typography, tone of voice, contact
 * identity — from what the site actually shows. IT NEVER WRITES the brand:
 * the draft goes back to the browser, the human edits and approves, and the
 * save happens through set_tenant_brand_identity (mig 666) under their own
 * JWT. The only side effect is one audit_events row recording that a draft
 * was produced.
 *
 * Hard rules:
 *  - the URL must pass isSafeExternalUrl BEFORE the fetch, and the final
 *    (post-redirect) URL is re-checked — a safe URL that redirects somewhere
 *    private is a refusal, not a fetch;
 *  - fetched website content is UNTRUSTED: it goes to the model wrapped in
 *    wrapUntrusted + FIREWALL_RULES, exactly like every other external text;
 *  - colors in the draft must be 6-digit hexes; anything else is dropped to
 *    empty string here, and the save RPC validates again server-side;
 *  - draft-only: no table is touched besides the audit event.
 *
 * Auth: USER JWT ONLY, tenant_owner/tenant_admin — the same gate the save
 * RPC enforces, so this can never draft for someone who could not save.
 * Budget-gated + suspension-gated before any LLM spend.
 *
 * POST { url }
 *  -> 200 { ok:true, draft:{ overview, colors, typography, logo, voice, contact, outputs } }
 *  -> { ok:false, error, detail } otherwise.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hasLLMProvider } from '../_shared/llm.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { loadTenantGate, TENANT_SUSPENDED_BODY } from '../_shared/tenantStatus.ts';
import { reportEdgeError } from '../_shared/errorReport.ts';
import { budgetBlocked, rpcLoud } from '../_shared/rpcSafety.ts';
import { isSafeExternalUrl } from '../_shared/urlSafety.ts';
import { stripHtml, parseJsonLoose } from '../_shared/textPrep.ts';
import { makeCallModelText } from '../_shared/modelCall.ts';

const callModel = makeCallModelText('brand-extract', 3000, { temperature: 0 });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (error: string, detail: string, s: number) => json({ ok: false, error, detail }, s);

const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_CHARS = 400_000;
const MAX_TEXT_CHARS = 6000;
const HEX_RE = /^#[0-9a-f]{6}$/;

// The one shape the whole feature speaks — mirrored by the save RPC's
// whitelist (mig 666) and the BrandIdentityCard form.
const SECTIONS: Record<string, string[]> = {
  overview:   ['name', 'tagline', 'industry', 'website'],
  colors:     ['primary', 'secondary', 'tertiary', 'dark', 'light'],
  typography: ['headline', 'body'],
  logo:       ['url', 'placement', 'notes'],
  voice:      ['tone', 'dos', 'donts', 'example'],
  contact:    ['email', 'phone', 'address', 'footer'],
  outputs:    ['email_signoff', 'invoice_footer', 'social_cta'],
};

/** Coerce the model's JSON into exactly the SECTIONS shape: known keys only,
 *  strings only, colors either valid hex6 or empty. */
function coerceDraft(raw: Record<string, unknown>): Record<string, Record<string, string>> {
  const draft: Record<string, Record<string, string>> = {};
  for (const [section, fields] of Object.entries(SECTIONS)) {
    const src = (raw[section] ?? {}) as Record<string, unknown>;
    draft[section] = {};
    for (const f of fields) {
      let v = typeof src[f] === 'string' ? (src[f] as string).trim() : '';
      if (section === 'colors') {
        v = v.toLowerCase();
        if (v && !HEX_RE.test(v)) v = '';
      }
      draft[section][f] = v.slice(0, 1000);
    }
  }
  return draft;
}

/** Top hex colors by frequency in the raw HTML/CSS — evidence for the model,
 *  so palette picks come from the site rather than imagination. */
function topHexColors(html: string, limit = 10): string[] {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = `#${m[1].toLowerCase()}`;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([h, n]) => `${h} (×${n})`);
}

const MAX_STYLESHEETS = 3;
const MAX_CSS_CHARS = 200_000;
const STYLESHEET_TIMEOUT_MS = 5000;

/** Same-origin <link rel="stylesheet"> URLs from the page, each re-checked
 *  through the SSRF guard — a relative href resolves against the final page
 *  URL, never anywhere the page fetch was not already allowed to go. */
function stylesheetUrls(html: string, baseUrl: string, limit = MAX_STYLESHEETS): string[] {
  const urls: string[] = [];
  let base: URL;
  try { base = new URL(baseUrl); } catch { return urls; }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?stylesheet["'\s>]/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      const u = new URL(href, base);
      if (u.origin !== base.origin || !isSafeExternalUrl(u.href)) continue;
      if (!urls.includes(u.href)) urls.push(u.href);
      if (urls.length >= limit) break;
    } catch { /* unparsable href — skip */ }
  }
  return urls;
}

/** Fetch the page's same-origin stylesheets so font/custom-property
 *  definitions living in linked CSS are visible to the extractor. Failures
 *  just mean thinner evidence, never a refusal. */
async function fetchStylesheets(html: string, baseUrl: string): Promise<string> {
  const sheets = await Promise.all(stylesheetUrls(html, baseUrl).map(async (u) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), STYLESHEET_TIMEOUT_MS);
    try {
      const res = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'DreamTeamBrandBot/1.0 (+brand identity draft)' } });
      if (!res.ok || !isSafeExternalUrl(res.url || u)) return '';
      return (await res.text()).slice(0, MAX_CSS_CHARS);
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }));
  return sheets.filter(Boolean).join('\n');
}

/** CSS custom-property definitions (--name: value) in the corpus; a later
 *  definition wins, matching how the cascade usually reads. */
function customProps(css: string): Map<string, string> {
  const props = new Map<string, string>();
  for (const m of css.matchAll(/--([\w-]+)\s*:\s*([^;}]{1,200})/g)) {
    props.set(m[1], m[2].trim());
  }
  return props;
}

/** Substitute var(--name[, fallback]) references until stable (bounded, so a
 *  self-referential definition cannot loop). */
function resolveVars(value: string, props: Map<string, string>): string {
  let out = value;
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/var\(\s*--([\w-]+)\s*(?:,\s*([^()]*?)\s*)?\)/gi, (whole, name, fallback) =>
      props.get(name) ?? (fallback !== undefined ? fallback : whole));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function fontFamilies(corpus: string, limit = 6): string[] {
  const props = customProps(corpus);
  const seen = new Set<string>();
  for (const m of corpus.matchAll(/font-family:\s*([^;}"]{2,80})/gi)) {
    const fam = resolveVars(m[1].trim(), props);
    // A still-unresolved var() is no evidence at all — storing the literal
    // "var(--font)" is exactly the bug this resolver exists to prevent.
    if (fam && !/var\(/i.test(fam)) seen.add(fam);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('method_not_allowed', 'POST only', 405);
  let tenantId: string | null = null;
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const body = await req.json().catch(() => ({}));
    const url = String(body.url ?? '').trim();
    if (!isSafeExternalUrl(url)) return fail('bad_url', 'a public http(s) website URL is required', 400);

    // ── auth: USER JWT ONLY, same roles as the save RPC ──
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!bearer) return fail('unauthorized', 'user JWT required', 401);
    const { data: u } = await admin.auth.getUser(bearer);
    if (!u?.user) return fail('unauthorized', 'user JWT required', 401);
    const { data: prof } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', u.user.id).maybeSingle();
    tenantId = await resolveTenantWithRemoteAccess(admin, u.user.id, prof?.tenant_id, prof?.layer, body?.tenant_id);
    if (!tenantId) return fail('no_tenant', 'no tenant resolved for this user', 403);

    const gate = await loadTenantGate(admin, tenantId);
    if (gate.suspended) return json({ ok: false, ...TENANT_SUSPENDED_BODY }, 402);

    const asUser = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: mayEdit } = await asUser.rpc('auth_has_tenant_role', { required_roles: ['tenant_owner', 'tenant_admin'] });
    if (mayEdit !== true) return fail('insufficient_role', 'drafting the brand identity requires an owner or admin role', 403);

    // ── budget + brain, BEFORE any spend ──
    if (!(await hasLLMProvider(admin))) return fail('llm_not_configured', 'no AI engine key configured (Settings → AI Engine)', 503);
    const { data: budget, error: budgetErr } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (budgetBlocked(budgetErr, budget)) return fail('ai_budget_exceeded', 'this workspace has reached its AI budget', 429);

    // ── fetch the site (SSRF-guarded on entry AND after redirects) ──
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let html: string;
    let finalUrl: string;
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'DreamTeamBrandBot/1.0 (+brand identity draft)' } });
      finalUrl = res.url || url;
      if (!isSafeExternalUrl(finalUrl)) return fail('bad_url', 'the site redirected to a non-public address', 400);
      if (!res.ok) return fail('site_unreachable', `the site answered HTTP ${res.status}`, 422);
      const ctype = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml/i.test(ctype)) return fail('not_a_webpage', `expected an HTML page, got ${ctype || 'unknown content'}`, 422);
      html = (await res.text()).slice(0, MAX_HTML_CHARS);
    } catch {
      return fail('site_unreachable', 'could not fetch the site (timeout or network error)', 422);
    } finally {
      clearTimeout(timer);
    }

    // ── evidence pack: page text + measured colors/fonts, all UNTRUSTED ──
    // Linked same-origin CSS joins the corpus so font-family declarations and
    // the --custom-property definitions behind var() references are visible.
    const cssCorpus = [html, await fetchStylesheets(html, finalUrl)].filter(Boolean).join('\n');
    const metaBits: string[] = [];
    for (const m of html.matchAll(/<meta[^>]+(?:name|property)=["'](description|og:site_name|og:title|og:description|theme-color)["'][^>]+content=["']([^"']{1,300})["']/gi)) {
      metaBits.push(`${m[1]}: ${m[2]}`);
    }
    const title = html.match(/<title[^>]*>([^<]{1,200})</i)?.[1]?.trim() ?? '';
    const evidence = [
      `URL: ${finalUrl}`,
      title ? `TITLE: ${title}` : '',
      metaBits.length ? `META:\n${metaBits.join('\n')}` : '',
      `MEASURED COLORS (by frequency in markup/CSS): ${topHexColors(html).join(', ') || 'none found'}`,
      `FONT FAMILIES IN CSS: ${fontFamilies(cssCorpus).join(' | ') || 'none found'}`,
      `PAGE TEXT:\n${stripHtml(html).slice(0, MAX_TEXT_CHARS)}`,
    ].filter(Boolean).join('\n\n');

    const system = [
      'You draft a company brand identity spec from website evidence.',
      'Respond with ONLY a JSON object of this exact shape (every value a string; unknown = ""):',
      JSON.stringify(Object.fromEntries(Object.entries(SECTIONS).map(([s, fs]) => [s, Object.fromEntries(fs.map((f) => [f, '']))]))),
      'Rules: colors must be 6-digit lowercase hexes taken from the MEASURED COLORS evidence (pick the ones that read as brand colors, not greys used for body text — but dark/light neutrals belong in dark/light). typography names the font families the site actually uses. voice.tone is 2-3 sentences describing how the company writes, grounded in the page text; dos/donts are short comma-separated phrases; example is one on-brand sentence. contact fields only if present in the evidence — never invent an email, phone or address. outputs.email_signoff is a plausible sign-off line matching the voice; invoice_footer and social_cta likewise, or "".',
      FIREWALL_RULES,
    ].join('\n');

    const c = await callModel(admin, system, wrapUntrusted(evidence, 'website'));
    if ('error' in c) return fail('llm_failed', c.error, 502);
    const raw = parseJsonLoose(c.text);
    if (!raw) return fail('draft_unparseable', 'the model did not return a valid draft — try again', 502);
    const draft = coerceDraft(raw);

    // The ONE permitted side effect: record that a draft was produced.
    await rpcLoud(admin, 'append_audit_event', {
      p_tenant_id: tenantId,
      p_actor: String(u.user.email ?? 'admin'),
      p_actor_type: 'human',
      p_action: `Brand identity drafted from ${finalUrl} — draft only, nothing saved.`,
      p_category: 'config_change',
      p_detail: { url: finalUrl, draft_only: true, input_tokens: c.inTok, output_tokens: c.outTok },
    });

    return json({ ok: true, draft });
  } catch (err) {
    await reportEdgeError('brand-extract', err, {}, tenantId);
    return fail('internal_error', String((err as Error)?.message ?? err), 500);
  }
});
