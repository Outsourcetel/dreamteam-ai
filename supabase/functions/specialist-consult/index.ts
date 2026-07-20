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
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { getAIKey } from '../_shared/aiKeys.ts';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';
import { wrapUntrusted, FIREWALL_RULES } from '../_shared/injectionSafety.ts';
import { resolveDeModel } from '../_shared/deModel.ts';

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

// ── Keyword fallback (last-resort only — see hybrid_match_knowledge, migration 046) ──
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
async function checkAnswerGuardrails(admin: SupabaseClient, tenantId: string, answer: string, deId: string | null): Promise<GuardrailRule | null> {
  try {
    // Scope-aware (Wave 2a). The specialist is a Digital Employee now
    // (migrations 208/211), so deId is its DE id → the specialist's own
    // employee-level guardrails apply on top of the workspace-wide ones.
    const { data: rules } = await admin
      .rpc('guardrail_rules_for_de', {
        p_tenant_id: tenantId,
        p_de_id: deId,
        p_rule_types: ['blocked_phrase', 'blocked_topic'],
      });
    if (!Array.isArray(rules)) return null;
    const blocking = (rules as Array<GuardrailRule & { severity?: string }>).filter((r) => r.severity === 'blocking');
    const text = answer.toLowerCase();
    for (const r of blocking as GuardrailRule[]) {
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

// ── Migration 034: proactive-poll helpers ──

/** Deterministic confidence (mirrors compute_inquiry_confidence in SQL
 *  exactly, in case the RPC round-trip is skipped) — kept identical to
 *  the SQL formula so the number shown never disagrees with the SQL
 *  triage function that gates on it. Called client-side here only to
 *  pass into decide_inquiry_triage as a single source of truth; the
 *  SQL function does not recompute it, it trusts this input, exactly
 *  like getApprovalThresholdCents/generateInvoice trust the amount
 *  the caller already knows. */
function computeConfidenceFallback(inputs: Record<string, unknown>): number {
  const num = (v: unknown) => typeof v === 'number' ? v : 0;
  const bool = (v: unknown) => v === true;
  const raw = 40
    + Math.min(24, 8 * num(inputs.knowledge_hits))
    + Math.min(24, 8 * num(inputs.history_corroborations))
    + (bool(inputs.account_context_found) ? 12 : 0)
    - 15 * num(inputs.systems_failed)
    - 15 * num(inputs.systems_denied_no_access);
  return Math.max(0, Math.min(97, Math.round(raw)));
}

async function upsertWatch(admin: SupabaseClient, tenantId: string, connectorId: string, ref: string) {
  const { error } = await admin.rpc('upsert_inbox_watch_state', {
    p_tenant_id: tenantId, p_connector_id: connectorId, p_external_ref: ref, p_timestamp: new Date().toISOString(),
  });
  if (error) console.error('upsert_inbox_watch_state:', error.message);
}
async function touchWatch(admin: SupabaseClient, tenantId: string, connectorId: string) {
  const { error } = await admin.rpc('touch_inbox_watch_state', { p_tenant_id: tenantId, p_connector_id: connectorId });
  if (error) console.error('touch_inbox_watch_state:', error.message);
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
  const { data: secretRow } = await admin.from('connector_secrets_decrypted')
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
  if (actionKey === 'reply_to_ticket') {
    // Public reply — the customer sees this. Still server-composed from
    // the consultation only, never caller-supplied free text (same
    // structural anti-hallucination guarantee as add_internal_note).
    const body = consultation.answer
      ? consultation.answer.slice(0, 1600)
      : `Thanks for your patience — we're looking into this and will follow up shortly. (Consultation ${consultation.id} recorded without a written answer yet — LLM dormant.)`;
    return { ok: true, payload: { body } };
  }
  return { ok: false, error: 'unsupported_action_key' };
}

// ════════════════════════════════════════════════════════════════
// runResolveInquiry — the EVIDENCE PIPELINE (v4: CATEGORY CONTRACTS),
// extracted (migration 034) so BOTH the human-invoked 'resolve_inquiry'
// HTTP action and the proactive 'poll_support_inbox' action share the
// exact same pipeline byte-for-byte — no parallel implementation.
//
// subjectKind/subjectId control WHOSE data_access_grants are enforced
// on every category_op call (migration 029, default-deny). The
// human-invoked path always passes the Technical Specialist (unchanged
// behavior); the proactive path passes whichever DE/specialist
// poll_support_inbox_targets resolved as having 'search' access to the
// connector that has new tickets — so a revoked grant produces the
// SAME denied_no_access steps a human-invoked run would see, honestly.
// ════════════════════════════════════════════════════════════════
interface RunResolveInquiryResult {
  evidence_run_id: string; status: string;
  steps: unknown[]; confidence_inputs: Record<string, unknown>;
  answer_status: string; answer: string | null; note?: string;
  conversation_facts_reused?: Record<string, unknown>;
  /** the account-context category this run resolved (product_system,
   *  else crm) — surfaced so callers outside the per-category poller
   *  loop (simulate_inquiry) can still pass a real category into
   *  record_inquiry_decision for experience-memory recording. */
  resolved_category?: string;
}
async function runResolveInquiry(
  admin: SupabaseClient, tenantId: string, inquiry: string, accountRef: string | null,
  opts: {
    profileKey?: string; deId?: string | null; subjectKind?: 'de' | 'specialist'; subjectId?: string | null;
    conversationId?: string | null;
    /** Wave 3 (bounded DE consultation, migration 111) — internal
     *  recursion guard. Set to 1 automatically when this call IS a
     *  consultation (see Step 3c below) so the consulted DE's own
     *  evidence-gathering never itself consults a third DE. Single-
     *  hop only, by construction — not full Composition/fan-out. */
    consultDepth?: number;
  } = {},
): Promise<RunResolveInquiryResult> {
  // Specialists are Digital Employees now (migrations 208/211). Resolve the
  // specialist DE by its specialist_key; its id is the subject id used on the
  // DE rails (grants, experience, evidence).
  const { data: prof2 } = await admin.from('digital_employees')
    .select('id, name, persona_name').eq('tenant_id', tenantId)
    .eq('is_specialist', true).eq('specialist_key', String(opts.profileKey ?? 'technical')).maybeSingle();

  // Default subject: the Technical Specialist (unchanged behavior for
  // the human-invoked path). The proactive path overrides this with
  // whichever subject actually holds the access grant.
  const subjectKind: 'de' | 'specialist' = opts.subjectKind ?? 'specialist';
  const subjectId: string | null = opts.subjectKind ? (opts.subjectId ?? null) : (prof2?.id ?? null);

  // ── CONVERSATION-SCOPED FACTS (migration 044, closes gap-analysis
  // item 5) — if this run is part of an existing conversation thread,
  // check for facts ALREADY ESTABLISHED this conversation (account_ref
  // resolved, category determined on a prior turn) and EXTEND rather
  // than re-derive from scratch. Structured lookup only — no
  // summarization, just literal jsonb values already recorded by a
  // prior turn of THIS SAME conversation_id.
  let establishedFacts: Record<string, unknown> = {};
  if (opts.conversationId) {
    const { data: facts } = await admin.rpc('get_conversation_facts', {
      p_tenant_id: tenantId, p_conversation_id: opts.conversationId,
    });
    establishedFacts = (facts ?? {}) as Record<string, unknown>;
  }
  // A follow-up turn that doesn't name an account reuses the one
  // already resolved this thread (extend, don't restart) — but a turn
  // that DOES name a (different) account always wins, honestly letting
  // the customer redirect the conversation mid-thread.
  const effectiveAccountRef = accountRef || (typeof establishedFacts.account_ref === 'string' ? establishedFacts.account_ref : null);
  const reusedAccountFromThread = !accountRef && !!effectiveAccountRef;

  const { data: runRow, error: runErr } = await admin.from('evidence_runs').insert({
    tenant_id: tenantId, specialist_de_id: subjectKind === 'specialist' ? subjectId : (prof2?.id ?? null),
    de_id: opts.deId ?? (subjectKind === 'de' ? subjectId : null),
    inquiry, account_ref: effectiveAccountRef, status: 'running',
  }).select('id').single();
  if (runErr || !runRow) throw new Error(runErr?.message ?? 'evidence_run insert failed');
  const runId2 = runRow.id as string;
  accountRef = effectiveAccountRef;

  interface Citation { system: string; ref: string; title: string; url: string | null; snippet: string }
  interface EvidenceStep {
    kind: string; system: string; query: string;
    outcome: 'ok' | 'skipped_not_connected' | 'failed' | 'denied_no_access';
    summary: string; item_count: number; latency_ms: number; citations: Citation[];
    category?: string; op?: string; provider?: string;
  }
  const steps: EvidenceStep[] = [];
  const actorName = prof2?.persona_name ?? prof2?.name ?? 'Technical Specialist';

  const recordStep = async (s: EvidenceStep) => {
    steps.push(s);
    await audit(admin, tenantId, actorName,
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
          // resolved subject — the hub enforces default-deny grants.
          subject_kind: subjectKind, subject_id: subjectId,
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
    `No access — blocked by your data access rules: the ${subjectKind === 'de' ? 'DE' : 'specialist'} needs "${denial?.needed ?? 'access'}" permission on this system${denial?.has ? ` and has only "${denial.has}"` : ' and has no grant'}. An admin can change this under Governance → Data Access.`;
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

  // ── Step 2: knowledge — hybrid (lexical + semantic via RRF, migration 046) ──
  {
    const started = Date.now();
    const kCitations: Citation[] = [];
    let kCount = 0;
    const qEmb = await embedText(inquiry);
    // KNOWLEDGE SCOPES (030): this step runs AS the resolved subject.
    const { data: chunks, error: hybridErr } = await admin.rpc('hybrid_match_knowledge', {
      p_tenant_id: tenantId, p_query_text: inquiry, p_account_id: null, p_query_embedding: qEmb,
      p_match_count: 5, p_subject_kind: subjectId ? subjectKind : null, p_subject_id: subjectId,
    });
    if (hybridErr) console.error('hybrid_match_knowledge:', hybridErr.message);
    for (const c of (Array.isArray(chunks) ? chunks : []).slice(0, 5)) {
      kCitations.push({ system: 'DreamTeam knowledge', ref: String(c.doc_id), title: c.doc_title ?? 'Knowledge document', url: null, snippet: String(c.content ?? '').slice(0, 200) });
      kCount++;
    }
    // Last-resort fallback: only when the RPC itself errored, not when it
    // legitimately found nothing.
    if (kCount === 0 && hybridErr) {
      const { data: docs } = await admin.rpc('visible_knowledge_docs', {
        p_tenant_id: tenantId,
        p_subject_kind: subjectId ? subjectKind : null, p_subject_id: subjectId,
      });
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

  // ── Step 3b: prior experience — THIS SUBJECT's own past decisions on
  // THIS account/record (migration 044, closes gap-analysis item 24).
  // Distinct from Step 3 above: history_check searches EXTERNAL system
  // records (past tickets/conversations in the connected SoR); this
  // searches the DE/specialist's OWN internal memory of decisions IT
  // made, citing the real evidence_run/action_execution each came from.
  // Access-grant-checked via resolve_experience (029's SAME ladder,
  // entered category-first instead of connector-first) — if the grant
  // has been revoked, this step reports denied_no_access honestly,
  // exactly like every other step in this pipeline, never silently
  // substituting or leaking a citation the subject can no longer see.
  let priorExperienceCount = 0;
  const experienceCategory = acctCategory; // same category step 1 resolved (product_system, else crm)
  if (!accountRef) {
    await recordStep({ kind: 'prior_experience', system: 'DreamTeam memory', query: '', outcome: 'skipped_not_connected', summary: 'No account named in the inquiry — prior-experience lookup skipped.', item_count: 0, latency_ms: 0, citations: [] });
  } else {
    const started = Date.now();
    const { data: expRes } = await admin.rpc('resolve_experience', {
      p_tenant_id: tenantId, p_subject_kind: subjectKind, p_subject_id: subjectId,
      p_category: experienceCategory, p_external_ref: accountRef, p_limit: 3,
    });
    const env = (expRes ?? { allowed: true, rows: [] }) as { allowed: boolean; reason?: string; rows: Array<{ id: string; fact_summary: { what_happened: string; decision_made: string; outcome: string }; source_evidence_run_id: string | null; source_action_execution_id: string | null; created_at: string }> };
    const expCitations: Citation[] = (env.rows ?? []).map((r) => ({
      system: 'DreamTeam memory', ref: r.id, title: r.fact_summary.what_happened.slice(0, 160),
      url: null, snippet: `${r.fact_summary.decision_made} — ${r.fact_summary.outcome}`.slice(0, 200),
    }));
    priorExperienceCount = env.rows?.length ?? 0;
    await recordStep({
      kind: 'prior_experience', system: 'DreamTeam memory', query: accountRef,
      outcome: env.allowed ? 'ok' : 'denied_no_access',
      category: experienceCategory, op: 'resolve_experience', provider: 'internal',
      summary: env.allowed
        ? (priorExperienceCount > 0
            ? `${priorExperienceCount} prior experience(s) — ${actorName} has handled "${accountRef}" before. See citations below.`
            : `No prior experience recorded for "${accountRef}" yet — this looks like the first time ${actorName} has handled it.`)
        : `No access — blocked by your data access rules: ${actorName} needs "search" permission on ${experienceCategory} to recall its own prior experience here. An admin can change this under Governance → Data Access.`,
      item_count: priorExperienceCount, latency_ms: Date.now() - started, citations: expCitations,
    });
  }

  // ── Step 3c: DE consultation (Wave 3, bounded — migration 111).
  // NOT full Composition (docs §7.6 — Coordinator DE, multi-target
  // fan-out, synthesis). This is single-hop only (consultDepth guards
  // against a consulted DE consulting a third), governance-gated by
  // an explicit tenant-admin-configured allow-list (de_consultation_
  // grants — never an open "any DE can ask any DE anything"), and the
  // TARGET DE's own access grants are what actually run — this step
  // never widens the CALLING DE's own permissions, it just reuses
  // THIS SAME PIPELINE recursively as the target DE's identity
  // (docs §7.6 rule 3: "cannot escalate permissions").
  const consultDepth = opts.consultDepth ?? 0;
  if (subjectKind === 'de' && subjectId && consultDepth === 0) {
    const { data: grants } = await admin.from('de_consultation_grants')
      .select('id, target_de_id, category')
      .eq('tenant_id', tenantId).eq('requester_de_id', subjectId).eq('active', true);
    for (const g of (grants ?? []) as Array<{ id: string; target_de_id: string; category: string }>) {
      const { data: targetDe } = await admin.from('digital_employees')
        .select('id, name, persona_name').eq('id', g.target_de_id).eq('tenant_id', tenantId).maybeSingle();
      if (!targetDe) continue;
      const targetName = targetDe.persona_name || targetDe.name;
      const started = Date.now();
      try {
        const sub = await runResolveInquiry(admin, tenantId, inquiry, accountRef, {
          subjectKind: 'de', subjectId: targetDe.id, consultDepth: consultDepth + 1,
        });
        const answered = sub.answer_status === 'answered' && !!sub.answer;
        await recordStep({
          kind: 'de_consultation', system: `Consulted ${targetName}`, query: inquiry,
          outcome: answered ? 'ok' : 'skipped_not_connected',
          category: g.category, op: 'consult_de', provider: 'internal',
          summary: answered
            ? `Consulted ${targetName} (${g.category}) — governed by an active consultation grant, answered from ${targetName}'s own access, not this employee's.`
            : `Consulted ${targetName} (${g.category}), but no answer was available (${sub.note ?? sub.answer_status}).`,
          item_count: answered ? 1 : 0, latency_ms: Date.now() - started,
          citations: answered ? [{ system: `Consulted: ${targetName}`, ref: sub.evidence_run_id, title: `${targetName}'s answer`, url: null, snippet: (sub.answer ?? '').slice(0, 200) }] : [],
        });
        await audit(admin, tenantId, actorName,
          `Consulted ${targetName} on ${g.category} — "${inquiry.slice(0, 80)}"`,
          'de_consultation',
          { kind: 'de_consultation', requester_de_id: subjectId, target_de_id: targetDe.id, category: g.category, grant_id: g.id, target_evidence_run_id: sub.evidence_run_id, answered });
      } catch (e) {
        console.error('de_consultation step failed:', targetDe.id, e);
      }
    }
  }

  // ── Step 4: compose the evidence bundle ──
  const allCitations = steps.flatMap((s) => s.citations);
  const knowledgeHits = steps.filter((s) => s.kind === 'knowledge_search').reduce((n, s) => n + s.item_count, 0);
  const accountFound = steps.some((s) => s.kind === 'account_context' && s.outcome === 'ok' && s.item_count > 0);
  const confidenceInputs = {
    knowledge_hits: knowledgeHits,
    history_corroborations: historyMatches,
    prior_experience_hits: priorExperienceCount,
    account_context_found: accountFound,
    systems_consulted: steps.filter((s) => s.outcome === 'ok').length,
    systems_skipped_not_connected: steps.filter((s) => s.outcome === 'skipped_not_connected').length,
    systems_failed: steps.filter((s) => s.outcome === 'failed').length,
    systems_denied_no_access: steps.filter((s) => s.outcome === 'denied_no_access').length,
  };
  await recordStep({
    kind: 'compose', system: 'DreamTeam', query: inquiry, outcome: 'ok',
    summary: `Evidence bundle assembled: ${allCitations.length} citation(s) across ${new Set(allCitations.map((c) => c.system)).size} system(s); ${knowledgeHits} knowledge hit(s), ${historyMatches} past-case corroboration(s), ${priorExperienceCount} prior-experience citation(s), account context ${accountFound ? 'found' : 'not found'}.`,
    item_count: allCitations.length, latency_ms: 0, citations: [],
  });

  // ── CONVERSATION-SCOPED FACTS — persist what THIS turn established so
  // a follow-up message on the SAME conversation_id can extend rather
  // than restart (migration 044, closes gap-analysis item 5). Structured
  // literal values only (a ref string, a category string, a uuid) —
  // never a generated summary.
  if (opts.conversationId) {
    // NOTE: p_fact_value is a jsonb column/param — the supabase-js RPC
    // client already JSON-serializes whatever value is passed here, so
    // passing a raw string/value (NOT JSON.stringify(...)) is correct;
    // double-stringifying would store an escaped string-of-a-string
    // (e.g. "\"Acme Retail Co\"" instead of "Acme Retail Co"), which
    // would corrupt every downstream reuse of the fact.
    if (accountRef) {
      await admin.rpc('set_conversation_fact', {
        p_tenant_id: tenantId, p_conversation_id: opts.conversationId,
        p_fact_key: 'account_ref', p_fact_value: accountRef,
      });
    }
    await admin.rpc('set_conversation_fact', {
      p_tenant_id: tenantId, p_conversation_id: opts.conversationId,
      p_fact_key: 'category_determined', p_fact_value: acctCategory,
    });
    await admin.rpc('set_conversation_fact', {
      p_tenant_id: tenantId, p_conversation_id: opts.conversationId,
      p_fact_key: 'evidence_run_id', p_fact_value: runId2,
    });
  }

  // LLM answer step — dormant-honest, same gate as consult.
  const resolveApiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
  const { data: resolveBudgetCheck } = resolveApiKey
    ? await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId })
    : { data: null };
  const answerStatus = !resolveApiKey ? 'llm_not_configured' : (resolveBudgetCheck && resolveBudgetCheck.allowed === false) ? 'ai_budget_exceeded' : 'answered';
  let answerText: string | null = null;
  if (answerStatus === 'answered') {
    const evidenceText = allCitations.map((c, i) => `[${i + 1}] (${c.system} · ${c.ref}) ${c.title}: ${c.snippet}`).join('\n');
    // Per-DE model (Wave 1.2): the answering model follows the same DE
    // the token usage is attributed to.
    const usageDeId = opts.deId ?? (subjectKind === 'de' ? subjectId : null);
    const model = await resolveDeModel(admin, tenantId, usageDeId);
    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': resolveApiKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 1024,
        system: `Answer the customer inquiry ONLY from the evidence citations below. Cite [n] for every claim. If evidence is insufficient, say so plainly.\n\nEvidence:\n${wrapUntrusted(evidenceText, 'evidence-citations')}${FIREWALL_RULES}`,
        messages: [{ role: 'user', content: wrapUntrusted(inquiry, 'customer-inquiry') }],
      }),
    });
    if (res2.ok) {
      const d2 = await res2.json();
      // Claude 5 models can emit a 'thinking' block before the text block.
      answerText = String((d2.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '');
      admin.rpc('record_de_token_usage', {
        p_tenant_id: tenantId, p_de_id: usageDeId, p_model_id: model,
        p_input_tokens: d2.usage?.input_tokens ?? 0, p_output_tokens: d2.usage?.output_tokens ?? 0,
      }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });
    }
  }

  await admin.from('evidence_runs').update({
    status: 'complete', steps, confidence_inputs: confidenceInputs,
    answer_status: answerText ? 'answered' : answerStatus,
    answer: answerText, completed_at: new Date().toISOString(),
  }).eq('id', runId2);

  return {
    evidence_run_id: runId2, status: 'complete', steps,
    confidence_inputs: confidenceInputs,
    answer_status: answerText ? 'answered' : answerStatus,
    answer: answerText,
    note: answerText
      ? undefined
      : answerStatus === 'ai_budget_exceeded'
        ? 'Evidence gathered and cited — the final written answer is paused because this workspace has reached its AI usage limit for this month.'
        : 'Evidence gathered and cited — the final written answer unlocks when the LLM is activated (ANTHROPIC_API_KEY).',
    conversation_facts_reused: reusedAccountFromThread
      ? { account_ref: accountRef, note: `Continuing from earlier in this conversation — account "${accountRef}" was already resolved on a prior turn.` }
      : undefined,
    resolved_category: acctCategory,
  };
}

// ════════════════════════════════════════════════════════════════
// handlePollSupportInbox (migration 034) — RETIRED in migration 036.
// Its logic (poll_support_inbox_targets, hardcoded to
// category='helpdesk') is fully superseded by handlePollDeWorkSources
// below, which is a strict superset: same auth, same idempotent-
// cursor/diff logic, same evidence pipeline, but ANY of the 9
// category-contract categories instead of only helpdesk, plus the new
// decide-AND-act step. Deleted outright rather than left dangling —
// "deprecate cleanly, don't leave two competing pollers" — the old
// action string 'poll_support_inbox' is still accepted (routed to the
// new handler below) so no caller breaks.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// handlePollDeWorkSources — action: poll_de_work_sources, THE
// GENERALIZED TRIGGER (migration 036). The domain-agnostic successor
// to handlePollSupportInbox (034): identical shape, but iterates ALL
// 9 category-contract categories (poll_de_work_sources_targets,
// migration 036, drops the "where c.category = 'helpdesk'" filter
// that was the entire hardcode), frames each new item with the
// category's (tenant-overridable) work_item_framing template instead
// of a support-specific "customer says X" string, and — new — when
// the decision indicates the DE should ACT (not just answer) and a
// suitable action_definition is bound for the category, actually
// invokes connector-hub's execute_action (migration 035), proving the
// full loop notice -> understand -> decide -> ACT, not just
// notice -> understand -> decide -> record-intent.
//
// Callers: pg_cron (via invoke_playbook_dispatch, x-dispatch-secret)
// → all tenants; service-role key + body.tenant_id → one tenant. Same
// system-trigger scoping as handlePollSupportInbox.
//
// Per qualifying (connector, subject) pair, for ANY category:
//   1. list_recent on the connector, AS the resolved subject
//      (data_access_grants enforced, exactly as before).
//   2. Diff against inbox_watch_state — same idempotent cursor logic,
//      same table (already category-agnostic — no schema change).
//   3. Frame each new item via resolve_work_item_framing(category) —
//      "{title}"/"{snippet}" substituted into the category's plain-
//      language template (tenant-overridable configuration, not
//      hardcoded strings).
//   4. runResolveInquiry AS that subject (the SAME evidence pipeline,
//      unchanged — byte-identical to the helpdesk path).
//   5. decide_work_item_triage(category) — the category-parameterized
//      sibling of decide_inquiry_triage: guardrail-always-wins, then
//      trust-narrows-within-it, resolved against the answer_widget
//      dial scoped to this category (falling back to the legacy
//      tenant-wide row so existing configuration keeps working).
//   6. THE NEW STEP: if the decision would otherwise auto-send/act
//      (would_auto_send) AND a non-disabled action_definition is
//      registered for this category (resolve_action_definition_for_
//      category), call connector-hub's execute_action for real —
//      the SAME generalized action layer migration 035 built,
//      composed through decide_action_execution (destructive-always-
//      gates -> guardrail -> trust), recorded as 'would_act' (gated)
//      or 'acted' (auto-executed / executed-after-approval). If no
//      action_definition exists for the category, fall back to the
//      honest would_auto_send/needs_review/blocked_guardrail/
//      skipped_no_access recording — the SAME discipline as 034,
//      never inventing an action that isn't actually registered.
//   7. Cursor advances via upsert_inbox_watch_state — unchanged.
//   8. Every decision audited with plain-language reasoning — the
//      SAME discipline as 034, generalized to name the category.
// ════════════════════════════════════════════════════════════════
async function handlePollDeWorkSources(
  admin: SupabaseClient, req: Request, jwt: string, body: Record<string, unknown>,
): Promise<Response> {
  const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
  const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
  const isCron = !!dispatchSecret && headerSecret === dispatchSecret;
  const isServiceRole = jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!isCron && !isServiceRole) return json({ error: 'unauthorized' }, 401);

  const scopeTenant: string | null = isServiceRole ? ((body?.tenant_id as string) ?? null) : null;
  const results: Array<{ connector_id: string; category: string; new_items: number; decisions: Record<string, number> }> = [];

  const { data: targets } = await admin.rpc('poll_de_work_sources_targets', { p_tenant_id: scopeTenant });
  for (const t of (targets ?? []) as Array<{
    tenant_id: string; connector_id: string; connector_provider: string; connector_display_name: string;
    category: string;
    subject_kind: 'de' | 'specialist'; subject_id: string; subject_name: string;
    last_seen_external_ref: string | null; last_seen_timestamp: string | null;
  }>) {
    const connLabel = t.connector_display_name || t.connector_provider;
    const decisionCounts: Record<string, number> = {};
    try {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
          'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        },
        body: JSON.stringify({
          action: 'list_recent', connector_id: t.connector_id, tenant_id: t.tenant_id,
          subject_kind: t.subject_kind, subject_id: t.subject_id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.error === 'access_denied') {
        // Grant revoked between poll_de_work_sources_targets and now —
        // honest, audited, not a silent drop. Same stub-run pattern as
        // 034, generalized to name the category.
        const denialNote = `Access denied — ${connLabel} (${t.category}) access was revoked before this poll could check it. No item data was read.`;
        const { data: stubRun } = await admin.from('evidence_runs').insert({
          tenant_id: t.tenant_id,
          specialist_de_id: t.subject_kind === 'specialist' ? t.subject_id : null,
          de_id: t.subject_kind === 'de' ? t.subject_id : null,
          inquiry: `(proactive poll on ${connLabel} [${t.category}] — access denied before evidence gathering)`,
          status: 'complete', steps: [], confidence_inputs: {},
        }).select('id').single();
        await audit(admin, t.tenant_id, t.subject_name,
          `Proactive poll skipped — access to ${connLabel} (${t.category}) was revoked; no item processed.`,
          'access_control',
          { kind: 'proactive_poll', connector_id: t.connector_id, category: t.category, subject_kind: t.subject_kind, subject_id: t.subject_id, reason: 'access_denied' });
        if (stubRun?.id) {
          await admin.rpc('record_inquiry_decision', {
            p_tenant_id: t.tenant_id, p_evidence_run_id: stubRun.id,
            p_connector_id: t.connector_id, p_external_ref: null,
            p_source: 'proactive_trigger', p_decision: 'skipped_no_access',
            p_confidence: null, p_guardrail_rule_id: null, p_trust_level: null,
            p_reasoning: denialNote, p_inquiry_title: `Access check — ${connLabel}`,
            p_source_category: t.category,
          });
        }
        await touchWatch(admin, t.tenant_id, t.connector_id);
        results.push({ connector_id: t.connector_id, category: t.category, new_items: 0, decisions: { skipped_no_access: 1 } });
        continue;
      }
      const items = (data?.items ?? []) as Array<{ ref: string; title: string; snippet: string; url: string | null }>;
      // Newest-first (every adapter's contract, category-agnostic).
      // Same idempotent diff logic as 034, unchanged.
      const seenRef = t.last_seen_external_ref;
      const newest = items[0]?.ref ?? null;
      let toProcess: typeof items;
      if (!seenRef) {
        toProcess = items.slice(0, 5);
      } else {
        const seenIdx = items.findIndex((x) => x.ref === seenRef);
        toProcess = seenIdx === -1 ? items : items.slice(0, seenIdx);
      }

      // Category-specific, tenant-overridable framing (migration 036) —
      // configuration, not hardcoded strings in application code.
      const { data: framingTpl } = await admin.rpc('resolve_work_item_framing', {
        p_tenant_id: t.tenant_id, p_category: t.category,
      });
      const template = String(framingTpl ?? 'New {category} item needs review: {title} — {snippet}');
      const frame = (title: string, snippet: string) => template
        .replace(/\{title\}/g, title)
        .replace(/\{snippet\}/g, snippet ?? '')
        .replace(/\{category\}/g, t.category)
        .slice(0, 2000);

      // A registered action for this category, if any — resolved ONCE
      // per connector per tick (not per item) since the candidate
      // action does not depend on the item's content.
      // resolve_action_definition_for_category returns SETOF (0 or 1
      // rows) precisely so "no action registered" is an empty array,
      // never a single row of nulls (see migration 036 SQL comment).
      const actionDef = await admin.rpc('resolve_action_definition_for_category', {
        p_tenant_id: t.tenant_id, p_category: t.category,
      }).then((r) => {
        const rows = (r.data ?? []) as Array<{ id: string; action_key: string; label: string; param_schema: Array<{ name: string; type: string; required?: boolean }> }>;
        return rows[0] ?? null;
      });
      // DE-A4 (draft-for-approval): when the DE composes a real ANSWER,
      // the natural act is the REPLY — but the generic resolver prefers
      // non-destructive candidates (correct for autonomous acts), which
      // for helpdesk picks add_internal_note, whose `note` param is
      // never fillable here — so no reply draft was ever proposable.
      // Resolve reply_to_ticket separately; the item loop prefers it
      // whenever an answer exists. Its destructive flag means
      // decide_action_execution ALWAYS gates it into a human task
      // carrying the full draft — approval sends, autonomy stays zero.
      const replyDef = await admin
        .from('action_definitions')
        .select('id, action_key, label, param_schema')
        .eq('category', t.category).eq('action_key', 'reply_to_ticket').eq('status', 'active')
        .or(`scope.eq.platform,tenant_id.eq.${t.tenant_id}`)
        .limit(1).maybeSingle()
        .then((r) => (r.data ?? null) as { id: string; action_key: string; label: string; param_schema: Array<{ name: string; type: string; required?: boolean }> } | null);

      for (const item of toProcess) {
        // Atomic ownership claim (migration 109). poll_de_work_sources_
        // targets deliberately allows multiple subjects (DEs and/or
        // specialists) to be eligible on the same connector/category —
        // but inbox_watch_state's cursor is connector-level, not
        // subject-level, so without this claim every eligible subject
        // would independently re-run evidence gathering, triage, and
        // (if a registered action exists) a REAL action on the exact
        // same item. Whichever subject's insert lands first owns the
        // item; every other subject hits the unique (tenant_id,
        // connector_id, external_ref) constraint and is skipped here,
        // before any of that work happens — not recorded as a
        // duplicate decision, just honestly not processed by the
        // subject that lost the race.
        const { data: claimRows } = await admin
          .from('work_item_claims')
          .upsert(
            { tenant_id: t.tenant_id, connector_id: t.connector_id, external_ref: item.ref, category: t.category, owner_subject_kind: t.subject_kind, owner_subject_id: t.subject_id },
            { onConflict: 'tenant_id,connector_id,external_ref', ignoreDuplicates: true },
          )
          .select('id');
        if (!claimRows || claimRows.length === 0) {
          decisionCounts['already_claimed'] = (decisionCounts['already_claimed'] ?? 0) + 1;
          continue;
        }
        const claimId = (claimRows[0] as { id: string }).id;

        // The claim persists across ticks (unlike inbox_watch_state's
        // cursor), so a transient failure partway through this item
        // must release it — otherwise the item would be silently and
        // permanently dropped instead of retried next tick, which is
        // strictly worse than the pre-claim behavior (where a mid-loop
        // failure just left the cursor stale and the item came back
        // around naturally).
        try {

        const inquiryText = frame(item.title, item.snippet);
        const result = await runResolveInquiry(admin, t.tenant_id, inquiryText, null, {
          subjectKind: t.subject_kind, subjectId: t.subject_id,
        });
        const confidence = computeConfidenceFallback(result.confidence_inputs);
        const { data: triage } = await admin.rpc('decide_work_item_triage', {
          p_tenant_id: t.tenant_id, p_category: t.category, p_inquiry: inquiryText, p_confidence: confidence,
          p_de_id: t.subject_kind === 'de' ? t.subject_id : null,
        });
        let decision: string = triage?.decision ?? 'needs_review';
        let reasoning: string = triage?.reasoning ?? '';
        let actionExecutionId: string | null = null;

        // ── THE NEW STEP: decide-to-answer clearing the bar AND a
        // registered action existing for this category → actually try
        // to ACT via the generalized action layer (migration 035),
        // instead of only ever recording intent. If no action is
        // registered, or params can't be filled from the item alone,
        // fall back honestly to the original would_auto_send/
        // needs_review recording — never invent an action that isn't
        // really there.
        // Prefer the reply action when the DE composed a real answer —
        // see replyDef above. Falls back to the category's generic
        // (non-destructive-first) action otherwise.
        const chosenDef = (result.answer && result.answer.trim() && replyDef) ? replyDef : actionDef;
        if (decision === 'would_auto_send' && !chosenDef) {
          reasoning = `${reasoning} (No registered action was resolvable for ${t.category} — answer_present=${!!(result.answer && result.answer.trim())}, reply_registered=${!!replyDef}, generic_registered=${!!actionDef}.)`;
        }
        if (decision === 'would_auto_send' && chosenDef) {
          // Only attempt params we can honestly fill — a v1, honest
          // limit: an action needing OTHER fields is skipped here and
          // falls back to would_auto_send, not silently guessed at.
          //
          // `body` (a customer-visible reply) is the DE's COMPOSED
          // ANSWER from the evidence pipeline — never the inquiry
          // text. The original wiring echoed inquiryText back as the
          // reply body (written while the LLM was dormant and
          // result.answer was always null); with the brain live that
          // would have sent the customer their own question back.
          // No answer → body stays unfillable → honest fallback to
          // recording intent, exactly like any other missing param.
          const fillable: Record<string, string> = {
            external_ref: item.ref, title: item.title, snippet: item.snippet ?? '',
          };
          if (result.answer && result.answer.trim()) fillable.body = result.answer.slice(0, 4000);
          const missing = (chosenDef.param_schema ?? []).filter((p) => p.required && !(p.name in fillable));
          if (missing.length > 0) {
            // Honest telemetry: this silent fall-through cost hours of
            // live debugging — say WHY no action was attempted.
            reasoning = `${reasoning} (Action "${chosenDef.label}" considered but not attempted — missing required param(s): ${missing.map((m) => m.name).join(', ')}; answer_present=${!!(result.answer && result.answer.trim())}, reply_registered=${!!replyDef}.)`;
          }
          if (missing.length === 0) {
            const params: Record<string, string> = {};
            for (const p of chosenDef.param_schema ?? []) {
              if (p.name in fillable) params[p.name] = fillable[p.name];
            }
            const execRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
                'apikey': Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
              },
              body: JSON.stringify({
                action: 'execute_action', connector_id: t.connector_id, tenant_id: t.tenant_id,
                subject_kind: t.subject_kind, subject_id: t.subject_id,
                action_key: chosenDef.action_key, params,
              }),
            });
            const execData = await execRes.json().catch(() => ({}));
            if (execData?.error === 'access_denied') {
              // write_back not granted — honest fallback, not a crash.
              reasoning = `${reasoning} (An action is registered for ${t.category}, but this subject lacks write_back access to act on it — recorded as intent only.)`;
            } else if (execData?.gated) {
              decision = 'would_act';
              actionExecutionId = execData.execution_id ?? null;
              reasoning = `Would act: ${execData.reasoning ?? reasoning} Action considered: "${chosenDef.label}".`;
            } else if (execData?.ok) {
              decision = 'acted';
              actionExecutionId = execData.execution_id ?? null;
              reasoning = `Acted — ${execData.receipt ?? `executed "${chosenDef.label}"`}.`;
            } else {
              reasoning = `${reasoning} (Attempted to act via "${chosenDef.label}" but it failed: ${execData?.error ?? 'unknown error'} — recorded as intent only.)`;
            }
          }
        }

        const { data: rec } = await admin.rpc('record_inquiry_decision', {
          p_tenant_id: t.tenant_id, p_evidence_run_id: result.evidence_run_id,
          p_connector_id: t.connector_id, p_external_ref: item.ref,
          p_source: 'proactive_trigger', p_decision: decision,
          p_confidence: confidence, p_guardrail_rule_id: triage?.guardrail_rule_id ?? null,
          p_trust_level: triage?.trust_level ?? null, p_reasoning: reasoning,
          p_inquiry_title: item.title, p_source_category: t.category,
          p_frustration_score: triage?.frustration_score ?? null,
        });
        // action_execution_id is not a record_inquiry_decision param (it
        // is only known AFTER the act-attempt above, which runs before
        // this call) — set via a targeted follow-up update, unchanged
        // from before this migration.
        await admin.from('evidence_run_decisions')
          .update({ action_execution_id: actionExecutionId })
          .eq('id', (rec as { id?: string })?.id ?? '__none__');
        await admin.from('work_item_claims')
          .update({ evidence_run_decision_id: (rec as { id?: string })?.id ?? null })
          .eq('id', claimId);
        await audit(admin, t.tenant_id, t.subject_name,
          `Proactive triage — "${item.title.slice(0, 80)}" via ${connLabel} [${t.category}]: ${decision}`,
          'inquiry_triage',
          { kind: 'proactive_poll', connector_id: t.connector_id, category: t.category, external_ref: item.ref, evidence_run_id: result.evidence_run_id, decision, confidence, reasoning, action_execution_id: actionExecutionId });
        decisionCounts[decision] = (decisionCounts[decision] ?? 0) + 1;
        } catch (itemErr) {
          console.error('poll_de_work_sources item error:', t.connector_id, item.ref, itemErr);
          await admin.from('work_item_claims').delete().eq('id', claimId);
          decisionCounts['error'] = (decisionCounts['error'] ?? 0) + 1;
        }
      }

      if (newest) await upsertWatch(admin, t.tenant_id, t.connector_id, newest);
      else await touchWatch(admin, t.tenant_id, t.connector_id);
      results.push({ connector_id: t.connector_id, category: t.category, new_items: toProcess.length, decisions: decisionCounts });
    } catch (e) {
      console.error('poll_de_work_sources connector error:', t.connector_id, e);
      results.push({ connector_id: t.connector_id, category: t.category, new_items: 0, decisions: { error: 1 } });
    }
  }

  return json({ ok: true, targets: (targets ?? []).length, results });
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

    // action: poll_de_work_sources is a SYSTEM TRIGGER (pg_cron, all
    // tenants, ANY category — migration 036) and authenticates itself
    // via x-dispatch-secret — it has no single tenantId until it
    // resolves targets per-row, so it skips the standard per-request
    // tenant resolution below (mirrors playbook-execute's 'dispatch'
    // action, which does the same for the same reason). This is the
    // ONLY proactive poller the dispatch cron calls as of migration
    // 036 — invoke_playbook_dispatch() was updated to call this
    // action instead of 'poll_support_inbox'.
    if (action === 'poll_de_work_sources') {
      return await handlePollDeWorkSources(admin, req, jwt, body);
    }
    // action: poll_support_inbox — DEPRECATED (migration 034, replaced
    // by poll_de_work_sources in migration 036). No longer invoked by
    // the cron. Kept as a thin, honest redirect (not removed outright)
    // so any in-flight/cached caller from before this deploy still
    // gets a correct, non-broken response rather than a 400 — it
    // simply runs the SAME generalized poller, which naturally
    // includes helpdesk connectors (the only ones the old function
    // ever targeted). Not a second competing poller: this path is
    // dead code from the cron's perspective, exercised only if
    // something still calls the old action name directly.
    if (action === 'poll_support_inbox') {
      return await handlePollDeWorkSources(admin, req, jwt, body);
    }

    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin
        .from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body?.tenant_id);
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
      // conversation_id (migration 044): optional — when the caller
      // threads the SAME de_conversations id across turns (as
      // de-answer/widget-ask already do), this run checks for facts
      // established earlier in the thread and extends rather than
      // restarts. Backward compatible: omitted entirely, this behaves
      // exactly as before.
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null;
      if (!inquiry) return json({ error: 'inquiry_required' }, 400);

      try {
        const result = await runResolveInquiry(admin, tenantId!, inquiry, accountRef, {
          profileKey: String(body.profile_key ?? 'technical'),
          deId: typeof body.de_id === 'string' ? body.de_id : null,
          conversationId,
          // Human-invoked path: unchanged default (Technical Specialist subject).
        });
        return json(result);
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════
    // action: simulate_inquiry — DEMO-SAFE MANUAL TRIGGER. Lets a
    // human inject a test inquiry to watch the SAME pipeline + triage
    // composition run RIGHT NOW, without a real connector having new
    // data. VISIBLY tagged source='manual_simulation' in both the
    // evidence_run_decisions row and the audit trail — never
    // conflated with the genuine automatic path (source=
    // 'proactive_trigger'). This proves the mechanism honestly; it is
    // NOT a claim that automation is running against real tickets.
    // ════════════════════════════════════════════════════════════
    if (action === 'simulate_inquiry') {
      const inquiry = String(body.inquiry ?? '').trim();
      if (!inquiry) return json({ error: 'inquiry_required' }, 400);
      const { data: prof2 } = await admin.from('digital_employees')
        .select('id, name, persona_name').eq('tenant_id', tenantId).eq('is_specialist', true).eq('specialist_key', 'technical').maybeSingle();
      try {
        const result = await runResolveInquiry(admin, tenantId!, inquiry, String(body.account_ref ?? '').trim() || null, {
          subjectKind: 'specialist', subjectId: prof2?.id ?? null,
        });
        const confidence = computeConfidenceFallback(result.confidence_inputs);
        const { data: triage } = await admin.rpc('decide_inquiry_triage', {
          p_tenant_id: tenantId, p_inquiry: inquiry, p_confidence: confidence,
        });
        const decision = triage?.decision ?? 'needs_review';
        const rec = await admin.rpc('record_inquiry_decision', {
          p_tenant_id: tenantId, p_evidence_run_id: result.evidence_run_id,
          p_connector_id: null, p_external_ref: String(body.account_ref ?? '').trim() || null,
          p_source: 'manual_simulation', p_decision: decision,
          p_confidence: confidence, p_guardrail_rule_id: triage?.guardrail_rule_id ?? null,
          p_trust_level: triage?.trust_level ?? null, p_reasoning: triage?.reasoning ?? '',
          p_inquiry_title: inquiry, p_source_category: result.resolved_category ?? null,
          p_frustration_score: triage?.frustration_score ?? null,
        });
        await audit(admin, tenantId!, prof2?.name ?? 'Technical Specialist',
          `SIMULATION — "${inquiry.slice(0, 80)}": ${decision} (not a real ticket — demo/test trigger)`,
          'inquiry_triage',
          { kind: 'manual_simulation', evidence_run_id: result.evidence_run_id, decision, confidence, reasoning: triage?.reasoning ?? '' });
        return json({ ...result, decision, confidence, reasoning: triage?.reasoning ?? '', human_task_id: rec.data?.human_task_id ?? null, simulated: true });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════
    // action: mcp_test — reachability ping only (honest v1)
    // ════════════════════════════════════════════════════════════
    if (action === 'mcp_test') {
      const sourceId = String(body.source_id ?? '');
      if (!sourceId) return json({ error: 'source_id required' }, 400);
      const { data: src } = await admin.from('specialist_sources')
        .select('id, source_type, config, specialist_de_id')
        .eq('id', sourceId).maybeSingle();
      // The source belongs to a specialist DE now; resolve tenant via it.
      const { data: srcDe } = src?.specialist_de_id
        ? await admin.from('digital_employees').select('tenant_id').eq('id', src.specialist_de_id).maybeSingle()
        : { data: null };
      const srcTenant = (srcDe as { tenant_id?: string } | null)?.tenant_id;
      if (!src || srcTenant !== tenantId) return json({ error: 'source_not_found' }, 404);
      if (src.source_type !== 'mcp_server') return json({ error: 'not_an_mcp_source' }, 400);

      const cfg = (src.config ?? {}) as Record<string, unknown>;
      const endpoint = String(cfg.endpoint ?? '');
      if (!endpoint) return json({ error: 'no_endpoint_configured' }, 400);

      const headers: Record<string, string> = {};
      const authHeaderName = String(cfg.auth_header ?? '');
      if (authHeaderName) {
        const { data: secretRow } = await admin.from('specialist_source_secrets_decrypted')
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
        .select('id, tenant_id, specialist_de_id, question, answer, sources_used')
        .eq('id', consultationId).eq('tenant_id', tenantId).maybeSingle();
      if (!consultation) return json({ error: 'consultation_not_found' }, 404);

      // DATA ACCESS GRANTS: a Scribe write requires the specialist to hold
      // "write_back" on the target connector BEFORE the request is even
      // created (the human approval gate comes after — a grant is
      // necessary, never sufficient).
      const { data: writeVerdict } = await admin.rpc('resolve_access', {
        p_tenant_id: tenantId, p_subject_kind: 'specialist', p_subject_id: consultation.specialist_de_id,
        p_connector_id: connectorId, p_needed: 'write_back',
      });
      const wv = writeVerdict as { allowed?: boolean; has?: string | null; reason?: string } | null;
      if (!wv?.allowed) {
        await audit(admin, tenantId, 'Scribe (Technical Specialist)',
          `Scribe write-back REFUSED by data access rules — specialist has ${wv?.has ? `only "${wv.has}"` : 'no grant'} on connector ${connectorId} and needs "write_back". No request created, nothing written.`,
          'access_control',
          { kind: 'data_access_denied', subject_kind: 'specialist', subject_id: consultation.specialist_de_id, connector_id: connectorId, op: `scribe.${actionKey}`, needed: 'write_back', has: wv?.has ?? null, reason: wv?.reason ?? 'no_grant' });
        return json({
          error: 'access_denied',
          detail: `This specialist does not have write-back permission on that system — blocked by your data access rules${wv?.has ? ` (it has only "${wv.has}")` : ''}. An admin can grant it under Governance → Data Access.`,
          denial: { subject_kind: 'specialist', subject_id: consultation.specialist_de_id, connector_id: connectorId, needed: 'write_back', has: wv?.has ?? null },
        }, 403);
      }

      const built = buildScribePayload(actionKey, consultation, body.status_value ? String(body.status_value) : undefined);
      if (!built.ok) return json({ error: built.error }, 400);

      const { data: reqRow, error: reqErr } = await admin.from('scribe_requests')
        .insert({
          tenant_id: tenantId, specialist_de_id: consultation.specialist_de_id,
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
        // reply_to_ticket (migration 035, THE GENERALIZED ACTION LAYER)
        // added ADDITIVELY alongside the two original keys — backward
        // compatible, nothing about add_internal_note/update_status changed.
        const zdBody = reqRow.action_key === 'add_internal_note'
          ? { ticket: { comment: { body: String(p.note ?? ''), public: false } } }
          : reqRow.action_key === 'reply_to_ticket'
          ? { ticket: { comment: { body: String(p.body ?? ''), public: true } } }
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

    // Specialists are Digital Employees now (migrations 208/211). Resolve the
    // specialist DE by specialist_key; `prof` keeps the old shape so the consult
    // body below reads unchanged, but every id is the DE id (grants, sources,
    // guardrails, and cost attribution are all on DE rails).
    const { data: specDe } = await admin.from('digital_employees')
      .select('id, name, persona_name, status, charter').eq('tenant_id', tenantId)
      .eq('is_specialist', true).eq('specialist_key', profileKey).maybeSingle();
    if (!specDe) return json({ error: 'profile_not_found' }, 404);
    if (specDe.status !== 'active') return json({ error: 'profile_paused' }, 400);
    const prof = {
      id: specDe.id as string,
      name: (specDe.persona_name || specDe.name) as string,
      status: specDe.status as string,
      charter: ((specDe.charter as { mission?: string } | null)?.mission)
        ?? 'Answer only from configured sources; cite everything; escalate when unsure.',
    };

    const { data: sources } = await admin.from('specialist_sources')
      .select('*').eq('specialist_de_id', prof.id).eq('enabled', true)
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
        // KNOWLEDGE SCOPES (030): docs are first filtered by doc-level
        // visibility for THIS specialist subject; tag scoping applies ON TOP.
        const tags: string[] = Array.isArray(cfg.tags) ? (cfg.tags as string[]) : [];
        const { data: docs } = await admin.rpc('visible_knowledge_docs', {
          p_tenant_id: tenantId, p_subject_kind: 'specialist', p_subject_id: prof.id,
        });
        const scoped = ((docs ?? []) as KDoc[]).filter((d) =>
          tags.length === 0 || (d.tags ?? []).some((t) => tags.includes(t)));
        const titles: string[] = [];
        let added = 0;
        if (scoped.length > 0) {
          // Hybrid retrieval (lexical + semantic via RRF, migration 046) —
          // same shared RPC as de-answer/widget-ask. Tag scope is enforced
          // AFTER the RPC call (hybrid_match_knowledge only knows about
          // subject/visibility scoping, not this specialist's per-source
          // tag filter, so it's applied client-side same as before).
          const { data: chunks } = await admin.rpc('hybrid_match_knowledge', {
            p_tenant_id: tenantId, p_query_text: question, p_account_id: null,
            p_query_embedding: qEmbedding, p_match_count: 8,
            p_subject_kind: 'specialist', p_subject_id: prof.id,
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
          .eq('tenant_id', tenantId).eq('specialist_de_id', prof.id)
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
    const anthropicKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, specialist_de_id: prof.id, requested_by: requestedBy, run_id: runId,
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

    // Same enforcement gate the other 4 LLM call sites use — checked
    // right before spending real AI-provider cost.
    const { data: consultBudgetCheck } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: tenantId });
    if (consultBudgetCheck && consultBudgetCheck.allowed === false) {
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, specialist_de_id: prof.id, requested_by: requestedBy, run_id: runId,
        question, answer: null, confidence: null,
        sources_used: retrieved, status: 'blocked_budget',
      }).select('id').single();
      await bump('consultations');
      await audit(admin, tenantId, prof.name,
        `Consultation recorded (AI usage limit reached) — retrieval exercised across ${retrieved.length} source${retrieved.length === 1 ? '' : 's'}; answer blocked, this workspace is over its monthly AI usage budget`,
        'config_change',
        { kind: 'specialist_consult', consultation_id: row?.id ?? null, profile_key: profileKey, status: 'blocked_budget', requested_by: requestedBy, sources: retrieved.length });
      return json({
        error: 'ai_budget_exceeded',
        consultation_id: row?.id ?? null,
        retrieved_sources: retrieved,
        note: 'This workspace has reached its AI usage limit for this month — retrieval is live, the written answer is paused until next month or the budget is raised.',
      });
    }

    // ── Claude (grounded-only contract) ──
    // PB2.0: a playbook consult can hand the specialist the reference
    // material its earlier steps gathered (context.documents) — this
    // field was parsed but unused until now. It joins the grounded
    // sources as an explicitly-labeled, citable block.
    const runDocuments = typeof context.documents === 'string' ? context.documents.slice(0, 16000) : '';
    const system = `${prof.charter}

Answer ONLY from the source excerpts below. Every claim must trace to a cited source. If the sources don't support an answer, say so plainly, set confidence low, and set needs_escalation true. Always output JSON: {"answer": string, "confidence": 0-100, "citations": [source titles used], "needs_escalation": boolean}. Never invent facts.

Source excerpts:
${wrapUntrusted(groundedContext, 'grounded-sources')}${runDocuments ? `\n\n--- Reference material supplied by the requesting playbook ---\n${wrapUntrusted(runDocuments, 'playbook-documents')}` : ''}${FIREWALL_RULES}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages: [{ role: 'user', content: wrapUntrusted(question, 'consult-question') }] }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, specialist_de_id: prof.id, requested_by: requestedBy, run_id: runId,
        question, sources_used: retrieved, status: 'error',
      }).select('id').single();
      return json({ error: 'llm_error', status: res.status, consultation_id: row?.id ?? null, retrieved_sources: retrieved }, 502);
    }
    const data = await res.json();
    // Claude 5 models can emit a 'thinking' block before the text block.
    const parsed = parseModelJson((data.content ?? []).find((b: { type?: string }) => b.type === 'text')?.text ?? '');
    await bump('llm_calls');
    // The specialist IS a Digital Employee now (migrations 208/211), so its
    // consult cost is attributed to it like any other DE.
    admin.rpc('record_de_token_usage', {
      p_tenant_id: tenantId, p_de_id: prof.id, p_model_id: MODEL,
      p_input_tokens: data.usage?.input_tokens ?? 0, p_output_tokens: data.usage?.output_tokens ?? 0,
    }).then(({ error }: { error: unknown }) => { if (error) console.error('record_de_token_usage:', error); });

    // ── Guardrail answer-check (blocking) — now DE-scoped: the specialist's
    // own employee-level guardrails apply on top of the workspace ones. ──
    const blockedBy = await checkAnswerGuardrails(admin, tenantId, parsed.answer, prof.id);
    if (blockedBy) {
      const { data: row } = await admin.from('spec_consultations').insert({
        tenant_id: tenantId, specialist_de_id: prof.id, requested_by: requestedBy, run_id: runId,
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
      tenant_id: tenantId, specialist_de_id: prof.id, requested_by: requestedBy, run_id: runId,
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
