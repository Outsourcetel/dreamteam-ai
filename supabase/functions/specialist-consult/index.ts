/**
 * specialist-consult — the Specialist system's server brain (v1: Technical).
 *
 * Actions:
 *   { action: 'consult', profile_key, question, context?, requested_by?, run_id? }
 *     Load profile + enabled sources → retrieval per access mode:
 *       knowledge  (ingest)     — match_doc_chunks scoped by config.tags
 *                                 (fallback: keyword rank over tag-scoped docs)
 *       connector  (fetch_only) — live read_through ONLY when context
 *                                 provides a target ref (v1 keeps it simple);
 *                                 nothing persisted, audit-only
 *       connector  (ingest)     — cites the connector's synced working
 *                                 cache (support_tickets) matching the ref
 *       mcp_server              — registered reference (full MCP session =
 *                                 upgrade; honest label)
 *       link       (reference)  — cited, content not fetched in v1
 *       media      (ingest)     — extracted .txt/.md consult via their
 *                                 linked knowledge_doc; others cited by
 *                                 title/tags with extracted=false noted
 *     → Claude (grounded-only JSON contract, same as de-answer)
 *     → guardrail answer-check (blocking rules) → spec_consultations row
 *       + audit + usage metric 'consultations'.
 *     DORMANT-HONEST: no ANTHROPIC_API_KEY → status 'blocked_llm' row +
 *     {error:'llm_not_configured', retrieved_sources} so the retrieval
 *     plumbing is verifiable NOW.
 *
 *   { action: 'mcp_test', source_id }
 *     Connectivity ping (HEAD, fallback POST) to the registered MCP
 *     endpoint. Records the result in source config.last_test. HONEST:
 *     this is registration + reachability only — "full MCP session
 *     upgrade pending".
 *
 *   { action: 'scribe_create', consultation_id, connector_id, action_key,
 *     external_ref, status_value? }
 *     THE STRUCTURAL ANTI-HALLUCINATION PATH. Payload is built HERE from
 *     a whitelisted template per action, interpolated from the stored
 *     consultation (question/answer/citations) — the caller supplies NO
 *     free text. consultation_id is FK NOT NULL. Always creates a
 *     human_task (approval_gate, related_table='scribe_requests').
 *
 *   { action: 'scribe_decide', task_id, decision }
 *     Called by the decideHumanTask hook after the human decides.
 *     approve → execute the write_back into the SoR (inline Zendesk call,
 *     connector_actions registry + connector_secrets respected) →
 *     'executed' (or honest 'failed' with the structured error);
 *     reject → 'rejected'. Every outcome audited with the consultation
 *     citation chain (category connector_action, detail.kind='scribe_write').
 *
 * Auth: caller JWT → tenant; or service-role key + body.tenant_id
 * (playbook consult path).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const MODEL = 'claude-sonnet-5';
const MAX_CONTEXT_CHARS = 7000;
const ESCALATION_FLOOR = 60;

// ── Free edge embeddings (gte-small, 384 dims); null when unavailable ──
async function embedText(text: string): Promise<number[] | null> {
  try {
    // deno-lint-ignore no-explicit-any
    const SupabaseAI = (globalThis as any).Supabase?.ai;
    if (!SupabaseAI) return null;
    const session = new SupabaseAI.Session('gte-small');
    const out = await session.run(text, { mean_pool: true, normalize: true });
    const vec = Array.from(out as Iterable<number>);
    return vec.length === 384 ? vec : null;
  } catch {
    return null;
  }
}

// ── Keyword fallback (mirrors de-answer) ──
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'for', 'with', 'my', 'i', 'me', 'can', 'you', 'your', 'do', 'does', 'how', 'what',
  'why', 'when', 'where', 'please', 'need', 'want', 'help', 'about', 'it', 'this', 'that',
]);
function tokenize(s: string): string[] {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

interface KDoc { id: string; title: string; content: string; tags: string[] }
function rankDocs(question: string, docs: KDoc[]): KDoc[] {
  const qTokens = [...new Set(tokenize(question))];
  if (qTokens.length === 0) return docs.slice(0, 3);
  return docs.map((d) => {
    const title = tokenize(d.title), body = tokenize(d.content);
    const tags = (d.tags || []).flatMap((t) => tokenize(t));
    let score = 0;
    for (const q of qTokens) {
      if (title.includes(q)) score += 3;
      if (tags.includes(q)) score += 2;
      score += Math.min(3, body.filter((w) => w === q).length);
    }
    return { d, score };
  }).filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map((s) => s.d);
}

// ── Guardrail answer-check (same blocking contract as de-answer) ──
interface GuardrailRule { id: string; rule: string; rule_type: string; pattern: string | null }
async function checkAnswerGuardrails(admin: SupabaseClient, tenantId: string, answer: string): Promise<GuardrailRule | null> {
  try {
    const { data: rules } = await admin
      .from('guardrail_rules')
      .select('id, rule, rule_type, pattern')
      .eq('tenant_id', tenantId).eq('active', true).eq('severity', 'blocking')
      .in('rule_type', ['blocked_phrase', 'blocked_topic']);
    if (!Array.isArray(rules)) return null;
    const text = answer.toLowerCase();
    for (const r of rules as GuardrailRule[]) {
      if (!r.pattern) continue;
      for (const frag of r.pattern.split('|').map((p) => p.trim().toLowerCase()).filter(Boolean)) {
        let hit = false;
        try { hit = new RegExp(frag, 'i').test(answer); } catch { hit = text.includes(frag); }
        if (hit) return r;
      }
    }
    return null;
  } catch { return null; }
}

async function audit(
  admin: SupabaseClient, tenantId: string, actor: string, action: string,
  category: string, detail: Record<string, unknown>,
) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: actor, p_actor_type: 'de',
    p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('audit:', error.message);
}

interface ParsedAnswer { answer: string; confidence: number; citations: string[]; needs_escalation: boolean }
function parseModelJson(raw: string): ParsedAnswer {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const p = JSON.parse(text.slice(start, end + 1));
      return {
        answer: typeof p.answer === 'string' ? p.answer : raw.trim(),
        confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence)) || 0)),
        citations: Array.isArray(p.citations) ? p.citations.map(String)
          : Array.isArray(p.sources) ? p.sources.map(String) : [],
        needs_escalation: !!p.needs_escalation,
      };
    } catch { /* fall through */ }
  }
  return { answer: raw.trim(), confidence: 50, citations: [], needs_escalation: false };
}

interface RetrievedSource {
  source_id: string;
  source_type: string;
  access_mode: string;
  label: string;
  kind: 'content' | 'reference' | 'skipped';
  detail: string;
  doc_titles?: string[];
}

interface ZendeskCreds { email: string; api_token: string }

async function zendeskFetch(
  admin: SupabaseClient, connectorId: string, tenantId: string,
  path: string, init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  const { data: connector } = await admin.from('connectors')
    .select('id, base_url, provider').eq('id', connectorId).eq('tenant_id', tenantId).maybeSingle();
  if (!connector) return { ok: false, status: 0, body: null, error: 'connector_not_found' };
  const { data: secretRow } = await admin.from('connector_secrets')
    .select('secret').eq('connector_id', connectorId).maybeSingle();
  if (!secretRow?.secret) return { ok: false, status: 0, body: null, error: 'no_credentials' };
  let creds: ZendeskCreds;
  try {
    creds = JSON.parse(secretRow.secret);
    if (!creds.email || !creds.api_token) throw new Error('bad shape');
  } catch { return { ok: false, status: 0, body: null, error: 'invalid_credentials_format' }; }
  const auth = 'Basic ' + btoa(`${creds.email}/token:${creds.api_token}`);
  try {
    const res = await fetch(connector.base_url.replace(/\/+$/, '') + path, {
      ...init,
      headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, body, error: 'zendesk_auth_failed' };
    if (!res.ok) return { ok: false, status: res.status, body, error: `zendesk_error_${res.status}` };
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: `zendesk_unreachable: ${String(e).slice(0, 120)}` };
  }
}

// ── SCRIBE PAYLOAD TEMPLATES — the whitelist. Payloads are built ONLY
// here, interpolated from the stored consultation. No caller-supplied
// free text ever reaches the SoR. update_status values are a closed enum.
const SCRIBE_STATUS_VALUES = ['open', 'pending', 'hold', 'solved'] as const;

function buildScribePayload(
  actionKey: string,
  consultation: { id: string; question: string; answer: string | null; sources_used: unknown },
  statusValue?: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; error: string } {
  if (actionKey === 'add_internal_note') {
    const cites = Array.isArray(consultation.sources_used)
      ? (consultation.sources_used as Array<Record<string, unknown>>)
          .map((s) => String(s.label ?? s.title ?? s.source_id ?? '')).filter(Boolean)
      : [];
    const note = [
      `[DreamTeam Scribe — grounded write-back]`,
      `Consultation ${consultation.id}`,
      `Q: ${consultation.question.slice(0, 400)}`,
      consultation.answer ? `A: ${consultation.answer.slice(0, 1200)}` : `A: (consultation recorded without an answer — LLM dormant)`,
      cites.length ? `Sources: ${cites.join('; ')}` : 'Sources: none recorded',
    ].join('\n');
    return { ok: true, payload: { note } };
  }
  if (actionKey === 'update_status') {
    const status = String(statusValue ?? '');
    if (!(SCRIBE_STATUS_VALUES as readonly string[]).includes(status)) {
      return { ok: false, error: 'status_value must be one of: ' + SCRIBE_STATUS_VALUES.join(', ') };
    }
    return { ok: true, payload: { status } };
  }
  return { ok: false, error: 'unsupported_action_key' };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? 'consult';

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Auth: caller JWT → tenant, or service-role key + body.tenant_id ──
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin
        .from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
      tenantId = profile?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // ════════════════════════════════════════════════════════════
    // action: resolve_inquiry — the EVIDENCE PIPELINE (v4:
    // CATEGORY CONTRACTS — provider-agnostic, migration 027).
    //
    // For a customer inquiry, walk the connected systems by CATEGORY,
    // speaking canonical category ops (the hub translates to whatever
    // provider the customer actually runs):
    //   1. account_context  — product_system.search_records
    //                         (else crm.search_accounts)
    //   2. knowledge_search — internal knowledge chunks (embeddings,
    //                         keyword fallback) + knowledge_base
    //                         connectors via search_articles
    //   3. history_check    — helpdesk.search_tickets +
    //                         crm.search_conversations
    //   4. compose          — evidence bundle + confidence inputs;
    //                         the LLM answer step stays dormant-honest
    // Every evidence step records category + op + provider.
    //
    // Every step is honest: ok | skipped_not_connected | failed. The
    // whole run persists to evidence_runs; each step is audited.
    // PASS-THROUGH COMPROMISE (documented): for read-through systems
    // we persist ONLY citation metadata — title, ref, url, snippet
    // capped at 200 chars — never full payloads.
    // ════════════════════════════════════════════════════════════
    if (action === 'resolve_inquiry') {
      const inquiry = String(body.inquiry ?? '').trim();
      const accountRef = String(body.account_ref ?? '').trim() || null;
      if (!inquiry) return json({ error: 'inquiry_required' }, 400);

      const { data: prof2 } = await admin.from('specialist_profiles')
        .select('id, name').eq('tenant_id', tenantId)
        .eq('key', String(body.profile_key ?? 'technical')).maybeSingle();

      const { data: runRow, error: runErr } = await admin.from('evidence_runs').insert({
        tenant_id: tenantId, specialist_id: prof2?.id ?? null,
        de_id: typeof body.de_id === 'string' ? body.de_id : null,
        inquiry, account_ref: accountRef, status: 'running',
      }).select('id').single();
      if (runErr || !runRow) return json({ error: runErr?.message ?? 'evidence_run insert failed' }, 500);
      const runId2 = runRow.id as string;

      interface Citation { system: string; ref: string; title: string; url: string | null; snippet: string }
      interface EvidenceStep {
        kind: string; system: string; query: string;
        outcome: 'ok' | 'skipped_not_connected' | 'failed' | 'denied_no_access';
        summary: string; item_count: number; latency_ms: number; citations: Citation[];
        category?: string; op?: string; provider?: string;
      }
      const steps: EvidenceStep[] = [];
      const actorName = prof2?.name ?? 'Technical Specialist';

      const recordStep = async (s: EvidenceStep) => {
        steps.push(s);
        await audit(admin, tenantId!, actorName,
          `Evidence step ${steps.length} (${s.kind}) on ${s.system} — ${s.outcome}: ${s.summary}`,
          'evidence_step',
          { kind: 'evidence_step', evidence_run_id: runId2, step: s.kind, system: s.system, outcome: s.outcome, item_count: s.item_count, latency_ms: s.latency_ms, category: s.category ?? null, op: s.op ?? null, provider: s.provider ?? null });
      };

      interface HubItemLite { external_ref: string; title: string; snippet: string; url: string | null }
      // CATEGORY CONTRACT: the pipeline speaks canonical ops; the hub
      // translates to whatever provider the customer actually runs.
      const callCategoryOp = async (connectorId: string, op: string, params: Record<string, unknown>) => {
        const started = Date.now();
        try {
          const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
              'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            },
            body: JSON.stringify({
              action: 'category_op', connector_id: connectorId, tenant_id: tenantId, op, params,
              // DATA ACCESS GRANTS: every evidence call runs AS the
              // specialist subject — the hub enforces default-deny grants.
              subject_kind: 'specialist', subject_id: prof2?.id ?? null,
            }),
          });
          const data = await res.json().catch(() => ({}));
          return {
            ok: !!data.ok, items: (data.items ?? []) as HubItemLite[],
            error: data.error as string | null,
            denied: data.error === 'access_denied',
            denial: (data.denial ?? null) as { needed?: string; has?: string | null } | null,
            ms: Date.now() - started,
          };
        } catch (e) {
          return { ok: false, items: [] as HubItemLite[], error: String(e).slice(0, 140), denied: false, denial: null, ms: Date.now() - started };
        }
      };
      // Plain-language denial summary for the evidence trail.
      const denialSummary = (denial: { needed?: string; has?: string | null } | null) =>
        `No access — blocked by your data access rules: the specialist needs "${denial?.needed ?? 'access'}" permission on this system${denial?.has ? ` and has only "${denial.has}"` : ' and has no grant'}. An admin can change this under Governance → Data Access.`;
      // Pass-through compromise: persist metadata + ≤200-char snippet only.
      const toCitations = (system: string, items: HubItemLite[]): Citation[] =>
        items.slice(0, 5).map((i) => ({ system, ref: i.external_ref, title: i.title.slice(0, 160), url: i.url, snippet: (i.snippet ?? '').slice(0, 200) }));

      const { data: allConns } = await admin.from('connectors')
        .select('id, provider, display_name, category, status, access_mode')
        .eq('tenant_id', tenantId);
      const conns = (allConns ?? []).filter((c) => c.status !== 'disconnected');
      const byCategory = (category: string) => conns.filter((c) => c.category === category);
      const label = (c: { provider: string; display_name: string }) => c.display_name || c.provider;

      // ── Step 1: account context — product_system.search_records, else crm.search_accounts ──
      const productConn = byCategory('product_system')[0] ?? null;
      const crmConn = byCategory('crm')[0] ?? null;
      const acctConn = productConn ?? crmConn;
      const acctOp = productConn ? 'search_records' : 'search_accounts';
      const acctCategory = productConn ? 'product_system' : 'crm';
      if (!acctConn) {
        await recordStep({ kind: 'account_context', system: 'product system / CRM', query: accountRef ?? '', outcome: 'skipped_not_connected', summary: 'No product system or CRM connected — skipped honestly. Connect one to check account configuration.', item_count: 0, latency_ms: 0, citations: [] });
      } else if (!accountRef) {
        await recordStep({ kind: 'account_context', system: label(acctConn), query: '', outcome: 'skipped_not_connected', summary: 'No account named in the inquiry — account-configuration lookup skipped.', item_count: 0, latency_ms: 0, citations: [], category: acctCategory, op: acctOp, provider: acctConn.provider });
      } else {
        const r = await callCategoryOp(acctConn.id, acctOp, { query: accountRef });
        await recordStep({
          kind: 'account_context', system: label(acctConn), query: accountRef,
          outcome: r.ok ? 'ok' : r.denied ? 'denied_no_access' : 'failed',
          category: acctCategory, op: acctOp, provider: acctConn.provider,
          summary: r.ok
            ? (r.items.length > 0 ? `Found ${r.items.length} account record(s) for "${accountRef}" via ${acctCategory}.${acctOp} — configuration read live, not stored.` : `No account matching "${accountRef}" in ${label(acctConn)}.`)
            : r.denied ? denialSummary(r.denial)
            : `Live lookup failed: ${r.error}`,
          item_count: r.items.length, latency_ms: r.ms, citations: toCitations(label(acctConn), r.items),
        });
      }

      // ── Step 2: knowledge — internal chunks first ──
      {
        const started = Date.now();
        const kCitations: Citation[] = [];
        let kCount = 0;
        const qEmb = await embedText(inquiry);
        if (qEmb) {
          const { data: chunks } = await admin.rpc('match_doc_chunks', {
            p_tenant_id: tenantId, p_account_id: null, p_query_embedding: qEmb, p_match_count: 5,
          });
          for (const c of (Array.isArray(chunks) ? chunks : []).slice(0, 5)) {
            const { data: doc } = await admin.from('knowledge_docs').select('title').eq('id', c.doc_id).maybeSingle();
            kCitations.push({ system: 'DreamTeam knowledge', ref: String(c.doc_id), title: doc?.title ?? 'Knowledge document', url: null, snippet: String(c.content ?? '').slice(0, 200) });
            kCount++;
          }
        }
        if (kCount === 0) {
          const { data: docs } = await admin.from('knowledge_docs').select('id, title, content, tags').eq('tenant_id', tenantId);
          for (const d of rankDocs(inquiry, (docs ?? []) as KDoc[])) {
            kCitations.push({ system: 'DreamTeam knowledge', ref: d.id, title: d.title, url: null, snippet: d.content.slice(0, 200) });
            kCount++;
          }
        }
        await recordStep({
          kind: 'knowledge_search', system: 'DreamTeam knowledge', query: inquiry,
          outcome: 'ok',
          summary: kCount > 0 ? `${kCount} relevant passage(s) found in uploaded/ingested knowledge.` : 'No knowledge passages matched — knowledge base may need content.',
          item_count: kCount, latency_ms: Date.now() - started, citations: kCitations,
        });
      }

      // ── Step 2b: knowledge_base connectors — knowledge_base.search_articles ──
      const kbConns = byCategory('knowledge_base');
      if (kbConns.length === 0) {
        await recordStep({ kind: 'knowledge_search', system: 'external knowledge (knowledge base)', query: inquiry, outcome: 'skipped_not_connected', summary: 'No knowledge-base system connected — skipped honestly.', item_count: 0, latency_ms: 0, citations: [] });
      } else {
        for (const kc of kbConns) {
          const r = await callCategoryOp(kc.id, 'search_articles', { query: inquiry });
          await recordStep({
            kind: 'knowledge_search', system: label(kc), query: inquiry,
            outcome: r.ok ? 'ok' : r.denied ? 'denied_no_access' : 'failed',
            category: 'knowledge_base', op: 'search_articles', provider: kc.provider,
            summary: r.ok ? `${r.items.length} matching article(s) fetched live via knowledge_base.search_articles (${kc.access_mode === 'fetch_only' ? 'fetch-only — content never stored' : 'ingest mode'}).`
              : r.denied ? denialSummary(r.denial)
              : `Search failed: ${r.error}`,
            item_count: r.items.length, latency_ms: r.ms, citations: toCitations(label(kc), r.items),
          });
        }
      }

      // ── Step 3: history check — helpdesk.search_tickets + crm.search_conversations ──
      const histTargets = [
        ...byCategory('helpdesk').map((c) => ({ conn: c, category: 'helpdesk', op: 'search_tickets' })),
        ...byCategory('crm').map((c) => ({ conn: c, category: 'crm', op: 'search_conversations' })),
      ];
      let historyMatches = 0;
      if (histTargets.length === 0) {
        await recordStep({ kind: 'history_check', system: 'helpdesk / CRM', query: inquiry, outcome: 'skipped_not_connected', summary: 'No helpdesk or CRM connected — cannot verify against past cases; skipped honestly.', item_count: 0, latency_ms: 0, citations: [] });
      } else {
        for (const { conn: hc, category, op } of histTargets) {
          const r = await callCategoryOp(hc.id, op, { query: inquiry });
          historyMatches += r.ok ? r.items.length : 0;
          await recordStep({
            kind: 'history_check', system: label(hc), query: inquiry,
            outcome: r.ok ? 'ok' : r.denied ? 'denied_no_access' : 'failed',
            category, op, provider: hc.provider,
            summary: r.ok
              ? (r.items.length > 0 ? `${r.items.length} similar past case(s) found via ${category}.${op} — resolutions cited below for confidence.` : `No similar past cases via ${category}.${op} — this looks new; lower confidence.`)
              : r.denied ? denialSummary(r.denial)
              : `History search failed: ${r.error}`,
            item_count: r.items.length, latency_ms: r.ms, citations: toCitations(label(hc), r.items),
          });
        }
      }

      // ── Step 4: compose the evidence bundle ──
      const allCitations = steps.flatMap((s) => s.citations);
      const knowledgeHits = steps.filter((s) => s.kind === 'knowledge_search').reduce((n, s) => n + s.item_count, 0);
      const accountFound = steps.some((s) => s.kind === 'account_context' && s.outcome === 'ok' && s.item_count > 0);
      const confidenceInputs = {
        knowledge_hits: knowledgeHits,
        history_corroborations: historyMatches,
        account_context_found: accountFound,
        systems_consulted: steps.filter((s) => s.outcome === 'ok').length,
        systems_skipped_not_connected: steps.filter((s) => s.outcome === 'skipped_not_connected').length,
        systems_failed: steps.filter((s) => s.outcome === 'failed').length,
        systems_denied_no_access: steps.filter((s) => s.outcome === 'denied_no_access').length,
      };
      await recordStep({
        kind: 'compose', system: 'DreamTeam', query: inquiry, outcome: 'ok',
        summary: `Evidence bundle assembled: ${allCitations.length} citation(s) across ${new Set(allCitations.map((c) => c.system)).size} system(s); ${knowledgeHits} knowledge hit(s), ${historyMatches} past-case corroboration(s), account context ${accountFound ? 'found' : 'not found'}.`,
        item_count: allCitations.length, latency_ms: 0, citations: [],
      });

      // LLM answer step — dormant-honest, same gate as consult.
      const answerStatus = Deno.env.get('ANTHROPIC_API_KEY') ? 'answered' : 'llm_not_configured';
      let answerText: string | null = null;
      if (answerStatus === 'answered') {
        const evidenceText = allCitations.map((c, i) => `[${i + 1}] (${c.system} · ${c.ref}) ${c.title}: ${c.snippet}`).join('\n');
        const res2 = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: MODEL, max_tokens: 1024,
            system: `Answer the customer inquiry ONLY from the evidence citations below. Cite [n] for every claim. If evidence is insufficient, say so plainly.\n\nEvidence:\n${evidenceText}`,
            messages: [{ role: 'user', content: inquiry }],
          }),
        });
        if (res2.ok) {
          const d2 = await res2.json();
          answerText = String(d2.content?.[0]?.text ?? '');
        }
      }

      await admin.from('evidence_runs').update({
        status: 'complete', steps, confidence_inputs: confidenceInputs,
        answer_status: answerText ? 'answered' : 'llm_not_configured',
        answer: answerText, completed_at: new Date().toISOString(),
      }).eq('id', runId2);

      return json({
        evidence_run_id: runId2, status: 'complete', steps,
        confidence_inputs: confidenceInputs,
        answer_status: answerText ? 'answered' : 'llm_not_configured',
        answer: answerText,
        note: answerText ? undefined : 'Evidence gathered and cited — the final written answer unlocks when the LLM is activated (ANTHROPIC_API_KEY).',
      });
    }

    // ════════════════════════════════════════════════════════════
    // action: mcp_test — reachability ping only (honest v1)
    // ════════════════════════════════════════════════════════════
    if (action === 'mcp_test') {
      const sourceId = String(body.source_id ?? '');
      if (!sourceId) return json({ error: 'source_id required' }, 400);
      const { data: src } = await admin.from('specialist_sources')
        .select('id, source_type, config, profile_id, specialist_profiles!inner(tenant_id)')
        .eq('id', sourceId).maybeSingle();
      const srcTenant = (src as { specialist_profiles?: { tenant_id?: string } } | null)?.specialist_profiles?.tenant_id;
      if (!src || srcTenant !== tenantId) return json({ error: 'source_not_found' }, 404);
      if (src.source_type !== 'mcp_server') return json({ error: 'not_an_mcp_source' }, 400);

      const cfg = (src.config ?? {}) as Record<string, unknown>;
      const endpoint = String(cfg.endpoint ?? '');
      if (!endpoint) return json({ error: 'no_endpoint_configured' }, 400);

      const headers: Record<string, string> = {};
      const authHeaderName = String(cfg.auth_header ?? '');
      if (authHeaderName) {
        const { data: secretRow } = await admin.from('specialist_source_secrets')
          .select('secret').eq('source_id', sourceId).maybeSingle();
        if (secretRow?.secret) headers[authHeaderName] = secretRow.secret;
      }

      let ok = false, status = 0, note = '';
      try {
        const r = await fetch(endpoint, { method: 'HEAD', headers });
        status = r.status;
        ok = r.status < 500;
        note = `HEAD ${r.status}`;
      } catch {
        try {
          const r2 = await fetch(endpoint, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
          });
          status = r2.status;
          ok = r2.status < 500;
          note = `POST ${r2.status}`;
        } catch (e2) {
          note = `unreachable: ${String(e2).slice(0, 120)}`;
        }
      }

      const lastTest = { ok, status, note, at: new Date().toISOString() };
      await admin.from('specialist_sources')
        .update({ config: { ...cfg, last_test: lastTest } }).eq('id', sourceId);
      await audit(admin, tenantId, 'Technical Specialist',
        `MCP server connectivity test — ${endpoint} → ${ok ? 'reachable' : 'unreachable'} (${note}). Registration + ping only; full MCP session upgrade pending.`,
        'config_change',
        { kind: 'specialist_source', source_id: sourceId, test: lastTest });
      return json({ ok, status, note, upgrade_note: 'registered — full MCP session upgrade pending' });
    }

    // ════════════════════════════════════════════════════════════
    // action: scribe_create — structurally grounded write request
    // ════════════════════════════════════════════════════════════
    if (action === 'scribe_create') {
      const consultationId = String(body.consultation_id ?? '');
      const connectorId = String(body.connector_id ?? '');
      const actionKey = String(body.action_key ?? '');
      const externalRef = String(body.external_ref ?? '').trim();
      if (!consultationId) return json({ error: 'consultation_id required — a Scribe write must originate from a consultation' }, 400);
      if (!connectorId || !actionKey || !externalRef) return json({ error: 'connector_id, action_key, external_ref required' }, 400);

      const { data: consultation } = await admin.from('spec_consultations')
        .select('id, tenant_id, profile_id, question, answer, sources_used')
        .eq('id', consultationId).eq('tenant_id', tenantId).maybeSingle();
      if (!consultation) return json({ error: 'consultation_not_found' }, 404);

      // DATA ACCESS GRANTS: a Scribe write requires the specialist to hold
      // "write_back" on the target connector BEFORE the request is even
      // created (the human approval gate comes after — a grant is
      // necessary, never sufficient).
      const { data: writeVerdict } = await admin.rpc('resolve_access', {
        p_tenant_id: tenantId, p_subject_kind: 'specialist', p_subject_id: consultation.profile_id,
        p_connector_id: connectorId, p_needed: 'write_back',
      });
      const wv = writeVerdict as { allowed?: boolean; has?: string | null; reason?: string } | null;
      if (!wv?.allowed) {
        await audit(admin, tenantId, 'Scribe (Technical Specialist)',
          `Scribe write-back REFUSED by data access rules — specialist has ${wv?.has ? `only "${wv.has}"` : 'no grant'} on connector ${connectorId} and needs "write_back". No request created, nothing written.`,
          'access_control',
          { kind: 'data_access_denied', subject_kind: 'specialist', subject_id: consultation.profile_id, connector_id: connectorId, op: `scribe.${actionKey}`, needed: 'write_back', has: wv?.has ?? null, reason: wv?.reason ?? 'no_grant' });
        return json({
          error: 'access_denied',
          detail: `This specialist does not have write-back permission on that system — blocked by your data access rules${wv?.has ? ` (it has only "${wv.has}")` : ''}. An admin can grant it under Governance → Data Access.`,
          denial: { subject_kind: 'specialist', subject_id: consultation.profile_id, connector_id: connectorId, needed: 'write_back', has: wv?.has ?? null },
        }, 403);
      }

      const built = buildScribePayload(actionKey, consultation, body.status_value ? String(body.status_value) : undefined);
      if (!built.ok) return json({ error: built.error }, 400);

      const { data: reqRow, error: reqErr } = await admin.from('scribe_requests')
        .insert({
          tenant_id: tenantId, profile_id: consultation.profile_id,
          consultation_id: consultationId, connector_id: connectorId,
          action_key: actionKey, external_ref: externalRef,
          payload: built.payload, payload_source: 'consultation_citation',
          status: 'pending_approval',
        }).select().single();
      if (reqErr || !reqRow) return json({ error: reqErr?.message ?? 'scribe insert failed' }, 500);

      // ALWAYS gated in v1 — the human task is not optional.
      const { data: task, error: taskErr } = await admin.from('human_tasks')
        .insert({
          tenant_id: tenantId, type: 'approval_gate', source: 'de',
          title: `Scribe write-back — ${actionKey === 'add_internal_note' ? 'internal note' : 'status update'} on ticket #${externalRef}`,
          detail: `Grounded in consultation ${consultationId}. Payload: ${JSON.stringify(built.payload).slice(0, 400)}`,
          related_table: 'scribe_requests', related_id: reqRow.id,
        }).select().single();
      if (taskErr || !task) return json({ error: taskErr?.message ?? 'task insert failed' }, 500);

      await admin.from('scribe_requests').update({ task_id: task.id }).eq('id', reqRow.id);
      await audit(admin, tenantId, 'Scribe (Technical Specialist)',
        `Scribe write-back REQUESTED — ${actionKey} on ticket #${externalRef}, grounded in consultation ${consultationId}; awaiting human approval (always-gated v1)`,
        'approval',
        { kind: 'scribe_write', scribe_request_id: reqRow.id, consultation_id: consultationId, connector_id: connectorId, action_key: actionKey, external_ref: externalRef, task_id: task.id, payload_source: 'consultation_citation' });
      return json({ ok: true, request_id: reqRow.id, task_id: task.id, payload: built.payload, status: 'pending_approval' });
    }

    // ════════════════════════════════════════════════════════════
    // action: scribe_decide — human decided; execute or reject
    // ════════════════════════════════════════════════════════════
    if (action === 'scribe_decide') {
      const taskId = String(body.task_id ?? '');
      const decision = String(body.decision ?? '');
      if (!taskId || !['approved', 'rejected'].includes(decision)) {
        return json({ error: 'task_id and decision (approved|rejected) required' }, 400);
      }
      const { data: reqRow } = await admin.from('scribe_requests')
        .select('*').eq('task_id', taskId).eq('tenant_id', tenantId).maybeSingle();
      if (!reqRow) return json({ decided: false, reason: 'no_scribe_request_for_task' }, 404);
      if (reqRow.status !== 'pending_approval') {
        return json({ decided: false, reason: `request is ${reqRow.status}`, status: reqRow.status });
      }
      // The gate is real: the human task must actually be decided.
      const { data: task } = await admin.from('human_tasks')
        .select('id, status').eq('id', taskId).eq('tenant_id', tenantId).maybeSingle();
      if (!task || task.status !== decision) {
        return json({ decided: false, reason: 'task_decision_mismatch' }, 409);
      }

      if (decision === 'rejected') {
        await admin.from('scribe_requests').update({ status: 'rejected' }).eq('id', reqRow.id);
        await audit(admin, tenantId, 'Scribe (Technical Specialist)',
          `Scribe write-back REJECTED by human — ${reqRow.action_key} on ticket #${reqRow.external_ref} (consultation ${reqRow.consultation_id})`,
          'approval',
          { kind: 'scribe_write', scribe_request_id: reqRow.id, consultation_id: reqRow.consultation_id, decision: 'rejected' });
        return json({ decided: true, status: 'rejected' });
      }

      // Approved → execute the write-back (registry + secret respected).
      await admin.from('scribe_requests').update({ status: 'approved' }).eq('id', reqRow.id);
      const { data: actRow } = await admin.from('connector_actions')
        .select('enabled').eq('connector_id', reqRow.connector_id)
        .eq('action_key', reqRow.action_key).maybeSingle();

      let outcome: { ok: boolean; error?: string; status?: number };
      if (!actRow?.enabled) {
        outcome = { ok: false, error: 'action_disabled_in_registry' };
      } else {
        const p = (reqRow.payload ?? {}) as Record<string, unknown>;
        const zdBody = reqRow.action_key === 'add_internal_note'
          ? { ticket: { comment: { body: String(p.note ?? ''), public: false } } }
          : { ticket: { status: String(p.status ?? 'open') } };
        const r = await zendeskFetch(admin, reqRow.connector_id, tenantId,
          `/api/v2/tickets/${encodeURIComponent(reqRow.external_ref)}.json`,
          { method: 'PUT', body: JSON.stringify(zdBody) });
        outcome = { ok: r.ok, error: r.error, status: r.status };
      }

      const finalStatus = outcome.ok ? 'executed' : 'failed';
      await admin.from('scribe_requests').update({
        status: finalStatus,
        executed_at: outcome.ok ? new Date().toISOString() : null,
        result: outcome as Record<string, unknown>,
      }).eq('id', reqRow.id);

      await audit(admin, tenantId, 'Scribe (Technical Specialist)',
        outcome.ok
          ? `Scribe write-back EXECUTED — ${reqRow.action_key} on ticket #${reqRow.external_ref}, grounded in consultation ${reqRow.consultation_id}, human-approved`
          : `Scribe write-back FAILED — ${reqRow.action_key} on ticket #${reqRow.external_ref}: ${outcome.error ?? 'unknown'} (human-approved; recorded honestly)`,
        'connector_action',
        { kind: 'scribe_write', scribe_request_id: reqRow.id, consultation_id: reqRow.consultation_id, connector_id: reqRow.connector_id, action_key: reqRow.action_key, external_ref: reqRow.external_ref, result: outcome, payload_source: 'consultation_citation' });

      return json({ decided: true, status: finalStatus, result: outcome });
    }

    // ════════════════════════════════════════════════════════════
    // action: consult (default)
    // ════════════════════════════════════════════════════════════
    const profileKey = String(body.profile_key ?? 'technical');
    const question = String(body.question ?? '').trim();
    const context = (body.context ?? {}) as Record<string, unknown>;
    const requestedBy = ['human', 'de', 'playbook'].includes(String(body.requested_by))
      ? String(body.requested_by) : 'human';
    const runId: string | null = typeof body.run_id === 'string' ? body.run_id : null;
    if (!question) return json({ error: 'question required' }, 400);

    const { data: prof } = await admin.from('specialist_profiles')
      .select('*').eq('tenant_id', tenantId).eq('key', profileKey).maybeSingle();
    if (!prof) return json({ error: 'profile_not_found' }, 404);
    if (prof.status !== 'active') return json({ error: 'profile_paused' }, 400);

    const { data: sources } = await admin.from('specialist_sources')
      .select('*').eq('profile_id', prof.id).eq('enabled', true)
      .order('created_at', { ascending: true });

    // ── Retrieval per source, per access mode ──
    const retrieved: RetrievedSource[] = [];
    const contextParts: string[] = [];
    let used = 0;
    const push = (title: string, text: string) => {
      const budget = MAX_CONTEXT_CHARS - used;
      if (budget <= 0) return;
      const bodyText = text.slice(0, budget);
      contextParts.push(`[Source: ${title}]\n${bodyText}`);
      used += bodyText.length + title.length;
    };

    const qEmbedding = await embedText(question);

    for (const src of sources ?? []) {
      const cfg = (src.config ?? {}) as Record<string, unknown>;
      const label = src.label || src.source_type;

      if (src.source_type === 'knowledge') {
        // Tag-scoped knowledge_docs (customer chose ingest — it's ours to search).
        const tags: string[] = Array.isArray(cfg.tags) ? (cfg.tags as string[]) : [];
        let q = admin.from('knowledge_docs').select('id, title, content, tags').eq('tenant_id', tenantId);
        if (tags.length > 0) q = q.overlaps('tags', tags);
        const { data: docs } = await q;
        const scoped = (docs ?? []) as KDoc[];
        const titles: string[] = [];
        let added = 0;
        if (qEmbedding && scoped.length > 0) {
          const { data: chunks } = await admin.rpc('match_doc_chunks', {
            p_tenant_id: tenantId, p_account_id: null,
            p_query_embedding: qEmbedding, p_match_count: 8,
          });
          const scopedIds = new Set(scoped.map((d) => d.id));
          const titleById = new Map(scoped.map((d) => [d.id, d.title]));
          for (const c of (Array.isArray(chunks) ? chunks : [])) {
            if (!scopedIds.has(c.doc_id)) continue; // TAG SCOPE enforced
            if (added >= 4) break;
            const t = titleById.get(c.doc_id) ?? 'Knowledge document';
            push(t, String(c.content ?? ''));
            if (!titles.includes(t)) titles.push(t);
            added++;
          }
        }
        if (added === 0) {
          for (const d of rankDocs(question, scoped)) {
            push(d.title, d.content);
            titles.push(d.title);
            added++;
          }
        }
        retrieved.push({
          source_id: src.id, source_type: 'knowledge', access_mode: src.access_mode, label,
          kind: added > 0 ? 'content' : 'skipped',
          detail: added > 0
            ? `${added} passage${added === 1 ? '' : 's'} from ${titles.length} tag-scoped doc${titles.length === 1 ? '' : 's'}`
            : (scoped.length === 0 ? 'no docs match the configured tags' : 'no passages matched the question'),
          doc_titles: titles,
        });

      } else if (src.source_type === 'connector') {
        const connectorId = String(cfg.connector_id ?? '');
        const ticketRef = String(context.ticket_ref ?? context.external_ref ?? '').trim();
        if (src.access_mode === 'fetch_only') {
          // Read-through at consult time — ONLY when the context names a target (v1).
          if (!connectorId) {
            retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'fetch_only', label, kind: 'skipped', detail: 'no connector_id configured' });
          } else if (!ticketRef) {
            retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'fetch_only', label, kind: 'skipped', detail: 'no target ref in consult context — fetch-only sources need one (v1)' });
          } else {
            // DATA ACCESS GRANTS: opening a live record needs "read".
            const { data: rv } = await admin.rpc('resolve_access', {
              p_tenant_id: tenantId, p_subject_kind: 'specialist', p_subject_id: prof.id,
              p_connector_id: connectorId, p_needed: 'read',
            });
            if (!(rv as { allowed?: boolean } | null)?.allowed) {
              retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'fetch_only', label, kind: 'skipped', detail: 'No access — blocked by your data access rules (needs "read" on this system). An admin can change this under Governance → Data Access.' });
              await audit(admin, tenantId, 'Technical Specialist',
                `Consult read-through DENIED by data access rules — specialist lacks "read" on connector for ticket #${ticketRef}; nothing fetched`,
                'access_control',
                { kind: 'data_access_denied', subject_kind: 'specialist', subject_id: prof.id, connector_id: connectorId, op: 'consult.fetch_record', needed: 'read', has: (rv as { has?: string | null } | null)?.has ?? null });
              continue;
            }
            const r = await zendeskFetch(admin, connectorId, tenantId, `/api/v2/tickets/${encodeURIComponent(ticketRef)}.json`);
            if (r.ok) {
              const t = (r.body as { ticket?: Record<string, unknown> })?.ticket ?? {};
              push(`${label} — live ticket #${ticketRef} (fetched, not stored)`,
                `Subject: ${String(t.subject ?? '')}\nStatus: ${String(t.status ?? '')}\nDescription: ${String(t.description ?? '').slice(0, 1500)}`);
              retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'fetch_only', label, kind: 'content', detail: `ticket #${ticketRef} fetched live — nothing persisted` });
              await audit(admin, tenantId, 'Technical Specialist',
                `Consult read-through — ticket #${ticketRef} fetched live for a consultation, not persisted`,
                'connector_sync', { kind: 'specialist_fetch', source_id: src.id, connector_id: connectorId, external_ref: ticketRef, persisted: false });
            } else {
              retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'fetch_only', label, kind: 'skipped', detail: `live fetch failed: ${r.error ?? 'unknown'}` });
            }
          }
        } else {
          // ingest — consult the connector's synced working cache.
          let cacheQ = admin.from('support_tickets')
            .select('subject, body, status, external_ref')
            .eq('tenant_id', tenantId).neq('source', 'native').limit(3);
          if (ticketRef) cacheQ = cacheQ.eq('external_ref', ticketRef);
          const { data: cached } = await cacheQ;
          if (cached && cached.length > 0) {
            for (const t of cached) {
              push(`${label} — synced ticket #${t.external_ref}`, `Subject: ${t.subject}\nStatus: ${t.status}\n${String(t.body).slice(0, 1000)}`);
            }
            retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'ingest', label, kind: 'content', detail: `${cached.length} synced record${cached.length === 1 ? '' : 's'} from the working cache` });
          } else {
            retrieved.push({ source_id: src.id, source_type: 'connector', access_mode: 'ingest', label, kind: 'skipped', detail: 'no synced records in the working cache' });
          }
        }

      } else if (src.source_type === 'mcp_server') {
        const lastTest = (cfg.last_test ?? null) as { ok?: boolean } | null;
        retrieved.push({
          source_id: src.id, source_type: 'mcp_server', access_mode: src.access_mode, label,
          kind: 'reference',
          detail: `registered MCP endpoint${lastTest ? (lastTest.ok ? ' (reachable)' : ' (last ping failed)') : ' (untested)'} — full MCP session upgrade pending`,
        });

      } else if (src.source_type === 'link') {
        retrieved.push({
          source_id: src.id, source_type: 'link', access_mode: 'reference', label,
          kind: 'reference',
          detail: `reference link: ${String(cfg.url ?? '')} — cited, content not fetched in v1`,
        });

      } else if (src.source_type === 'media') {
        // Extracted .txt/.md media consult via their linked knowledge_doc
        // (covered by a knowledge source when tagged); here we surface the
        // library by title/tag match, honest about extraction state.
        const { data: assets } = await admin.from('media_assets')
          .select('id, title, kind, tags, extracted, knowledge_doc_id')
          .eq('tenant_id', tenantId).eq('profile_id', prof.id)
          .order('sort_order', { ascending: true }).limit(50);
        const qTokens = new Set(tokenize(question));
        const matches = (assets ?? []).filter((a) =>
          tokenize(a.title).some((w) => qTokens.has(w)) ||
          (a.tags ?? []).some((t: string) => tokenize(t).some((w) => qTokens.has(w))));
        for (const m of matches.slice(0, 3)) {
          if (m.extracted && m.knowledge_doc_id) {
            const { data: doc } = await admin.from('knowledge_docs')
              .select('title, content').eq('id', m.knowledge_doc_id).maybeSingle();
            if (doc) push(`Media: ${m.title}`, doc.content);
          }
        }
        retrieved.push({
          source_id: src.id, source_type: 'media', access_mode: 'ingest', label,
          kind: matches.length > 0 ? (matches.some((m) => m.extracted) ? 'content' : 'reference') : 'skipped',
          detail: matches.length > 0
            ? `${matches.length} matching asset${matches.length === 1 ? '' : 's'} (${matches.filter((m) => m.extracted).length} extracted; others indexed by title/tags — content extraction on activation)`
            : 'no media assets matched the question by title/tags',
          doc_titles: matches.map((m) => m.title),
        });
      }
    }

    const groundedContext = contextParts.length > 0
      ? contextParts.join('\n\n---\n\n')
      : 'No source content matched the question.';

    const bump = (metric: string) =>
      admin.rpc('increment_metric_tenant', { p_tenant_id: tenantId, p_metric: metric, p_delta: 1 })
        .then(({ error }) => { if (error) console.error('increment_metric_tenant:', error.message); });

    // ── DORMANT-HONEST: no key → blocked_llm row, plumbing returned ──
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, profile_id: prof.id, requested_by: requestedBy, run_id: runId,
        question, answer: null, confidence: null,
        sources_used: retrieved, status: 'blocked_llm',
      }).select('id').single();
      await bump('consultations');
      await audit(admin, tenantId, prof.name,
        `Consultation recorded (brain not activated) — retrieval exercised across ${retrieved.length} source${retrieved.length === 1 ? '' : 's'}; answer blocked pending ANTHROPIC_API_KEY`,
        'config_change',
        { kind: 'specialist_consult', consultation_id: row?.id ?? null, profile_key: profileKey, status: 'blocked_llm', requested_by: requestedBy, sources: retrieved.length });
      return json({
        error: 'llm_not_configured',
        consultation_id: row?.id ?? null,
        retrieved_sources: retrieved,
        note: 'Specialist brain not activated — configuration and retrieval are live; the answer path unlocks when ANTHROPIC_API_KEY is set.',
      });
    }

    // ── Claude (grounded-only contract) ──
    const system = `${prof.charter}

Answer ONLY from the source excerpts below. Every claim must trace to a cited source. If the sources don't support an answer, say so plainly, set confidence low, and set needs_escalation true. Always output JSON: {"answer": string, "confidence": 0-100, "citations": [source titles used], "needs_escalation": boolean}. Never invent facts.

Source excerpts:
${groundedContext}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: question }] }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, profile_id: prof.id, requested_by: requestedBy, run_id: runId,
        question, sources_used: retrieved, status: 'error',
      }).select('id').single();
      return json({ error: 'llm_error', status: res.status, consultation_id: row?.id ?? null, retrieved_sources: retrieved }, 502);
    }
    const data = await res.json();
    const parsed = parseModelJson(data.content?.[0]?.text ?? '');
    await bump('llm_calls');

    // ── Guardrail answer-check (blocking) ──
    const blockedBy = await checkAnswerGuardrails(admin, tenantId, parsed.answer);
    if (blockedBy) {
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, profile_id: prof.id, requested_by: requestedBy, run_id: runId,
        question, answer: null, confidence: 0, sources_used: retrieved, status: 'escalated',
      }).select('id').single();
      await admin.from('human_tasks').insert({
        tenant_id: tenantId, type: 'escalation', source: 'de',
        title: `Specialist guardrail block — ${question.slice(0, 60)}`,
        detail: `The specialist's draft answer was blocked by guardrail "${blockedBy.rule}". Draft: ${parsed.answer.slice(0, 400)}`,
        related_table: 'spec_consultations', related_id: row?.id ?? null,
      });
      await audit(admin, tenantId, prof.name,
        `BLOCKED — specialist answer matched guardrail "${blockedBy.rule}" and was withheld; escalated to human`,
        'guardrail_block',
        { kind: 'specialist_consult', consultation_id: row?.id ?? null, rule_id: blockedBy.id, rule: blockedBy.rule });
      await bump('consultations');
      return json({ consultation_id: row?.id ?? null, blocked: true, rule: blockedBy.rule, retrieved_sources: retrieved, needs_escalation: true });
    }

    const escalate = parsed.needs_escalation || parsed.confidence < ESCALATION_FLOOR;
    const { data: row } = await admin.from('spec_consultations').insert({
      tenant_id: tenantId, profile_id: prof.id, requested_by: requestedBy, run_id: runId,
      question, answer: parsed.answer, confidence: parsed.confidence,
      sources_used: retrieved.map((r) => ({ ...r, cited: parsed.citations.some((c) => r.label.includes(c) || (r.doc_titles ?? []).includes(c)) })),
      status: escalate ? 'escalated' : 'answered',
    }).select('id').single();
    await bump('consultations');

    if (escalate) {
      await admin.from('human_tasks').insert({
        tenant_id: tenantId, type: 'escalation', source: 'de',
        title: `Specialist escalation — ${question.slice(0, 60)}`,
        detail: `${prof.name} answered below the confidence floor (${parsed.confidence}%). Draft: ${parsed.answer.slice(0, 400)}`,
        related_table: 'spec_consultations', related_id: row?.id ?? null,
      });
    }
    await audit(admin, tenantId, prof.name,
      escalate
        ? `Consultation escalated to human — confidence ${parsed.confidence}% below floor ("${question.slice(0, 60)}")`
        : `Consultation answered from configured sources (confidence ${parsed.confidence}%) — "${question.slice(0, 60)}"`,
      escalate ? 'escalated' : 'resolved',
      { kind: 'specialist_consult', consultation_id: row?.id ?? null, profile_key: profileKey, confidence: parsed.confidence, requested_by: requestedBy, citations: parsed.citations });

    return json({
      consultation_id: row?.id ?? null,
      answer: parsed.answer,
      confidence: parsed.confidence,
      citations: parsed.citations,
      retrieved_sources: retrieved,
      needs_escalation: escalate,
    });
  } catch (err) {
    console.error('specialist-consult error:', err);
    return json({ error: String(err) }, 500);
  }
});
