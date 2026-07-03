/**
 * widget-ask — PUBLIC end-user widget endpoint (scale track, SCALING-ARCHITECTURE.md).
 *
 * End users are traffic, not seats: no Supabase auth. TCP embeds widget.js in
 * their product; the widget calls this endpoint with a publishable widget key
 * (sha256-matched against widget_keys) + an end-user context payload.
 *
 * Flow: hash key → resolve tenant (401 on miss) → rate check → upsert
 * end_user_session → resolve account (customer_accounts.external_ref, tolerant
 * if the column doesn't exist yet) → same answer pipeline as de-answer
 * (keyword retrieval → Claude strict-JSON → persist conversation → escalate to
 * human_tasks below confidence 60) with end-user context on the records.
 *
 * Deployed with verify_jwt=false — the widget key IS the auth.
 * If ANTHROPIC_API_KEY is unset returns {error:'llm_not_configured'} (HTTP 200).
 *
 * Rate limiting: per-key sliding-minute check using widget_keys.last_used_at +
 * a lightweight in-memory counter per isolate. TODO(scale): move to a proper
 * shared counter (widget_rate table or Redis-class store) before real volume —
 * in-memory counters reset on cold start and don't share across isolates.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });

const ESCALATION_THRESHOLD = 60;
const MAX_CONTEXT_CHARS = 6000;
const MODEL = 'claude-sonnet-5';
const RATE_LIMIT_PER_MIN = 100;

// Per-isolate sliding window: keyId -> timestamps (ms) of recent requests.
const rateWindows = new Map<string, number[]>();
function rateLimited(keyId: string): boolean {
  const now = Date.now();
  const win = (rateWindows.get(keyId) ?? []).filter((t) => now - t < 60_000);
  win.push(now);
  rateWindows.set(keyId, win);
  return win.length > RATE_LIMIT_PER_MIN;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Keyword-overlap retrieval (mirrors de-answer; de-answer is owned elsewhere) ──
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'for', 'with', 'my', 'i', 'me', 'can', 'you', 'your', 'do', 'does', 'how', 'what',
  'why', 'when', 'where', 'please', 'need', 'want', 'help', 'about', 'it', 'this', 'that',
]);

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

interface KDoc { id: string; title: string; content: string; tags: string[] }

function rankDocs(question: string, docs: KDoc[]): KDoc[] {
  const qTokens = [...new Set(tokenize(question))];
  if (qTokens.length === 0) return docs.slice(0, 3);
  const scored = docs.map((d) => {
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
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.d);
}

interface DEAnswer { answer: string; confidence: number; sources: string[]; needs_escalation: boolean }

function parseModelJson(raw: string): DEAnswer {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const p = JSON.parse(text.slice(start, end + 1));
      return {
        answer: typeof p.answer === 'string' ? p.answer : raw.trim(),
        confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence)) || 0)),
        sources: Array.isArray(p.sources) ? p.sources.map(String) : [],
        needs_escalation: !!p.needs_escalation,
      };
    } catch { /* fall through */ }
  }
  return { answer: raw.trim(), confidence: 50, sources: [], needs_escalation: false };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const widgetKey = body.widget_key;
    const question = body.question;
    if (!widgetKey || typeof widgetKey !== 'string') return json({ error: 'widget_key required' }, 400);
    if (!question || typeof question !== 'string' || !question.trim()) {
      return json({ error: 'question required' }, 400);
    }
    const accountRef = typeof body.account_ref === 'string' ? body.account_ref : null;
    const endUserRef = typeof body.end_user_ref === 'string' ? body.end_user_ref : null;
    const displayName = typeof body.display_name === 'string' ? body.display_name : null;
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : null;

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // ── Resolve tenant from publishable key ──
    const keyHash = await sha256Hex(widgetKey.trim());
    const { data: keyRow } = await admin
      .from('widget_keys')
      .select('id, tenant_id')
      .eq('key_hash', keyHash)
      .eq('active', true)
      .maybeSingle();
    if (!keyRow) return json({ error: 'invalid_widget_key' }, 401);
    const tenantId: string = keyRow.tenant_id;

    if (rateLimited(keyRow.id)) return json({ error: 'rate_limited' }, 429);

    // Usage bookkeeping (best effort; read-then-write is fine at pilot volume —
    // TODO(scale): replace with an atomic SQL increment RPC before real volume)
    try {
      const { data: cur } = await admin
        .from('widget_keys').select('request_count').eq('id', keyRow.id).single();
      await admin.from('widget_keys')
        .update({ last_used_at: new Date().toISOString(), request_count: (cur?.request_count ?? 0) + 1 })
        .eq('id', keyRow.id);
    } catch { /* non-fatal */ }

    // ── Upsert end-user session ──
    try {
      const { data: existing } = await admin
        .from('end_user_sessions')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('account_external_ref', accountRef ?? '')
        .eq('end_user_ref', endUserRef ?? '')
        .maybeSingle();
      if (existing) {
        await admin.from('end_user_sessions')
          .update({ last_seen_at: new Date().toISOString(), display_name: displayName ?? undefined })
          .eq('id', existing.id);
      } else {
        await admin.from('end_user_sessions').insert({
          tenant_id: tenantId,
          account_external_ref: accountRef ?? '',
          end_user_ref: endUserRef ?? '',
          display_name: displayName,
        });
      }
    } catch (e) {
      console.error('session upsert failed (non-fatal)', e);
    }

    // ── Resolve account by external_ref (tolerate missing column) ──
    let accountId: string | null = null;
    let accountName: string | null = null;
    if (accountRef) {
      const { data: acct, error: acctErr } = await admin
        .from('customer_accounts')
        .select('id, name')
        .eq('tenant_id', tenantId)
        .eq('external_ref', accountRef)
        .maybeSingle();
      if (acctErr) {
        // external_ref column may not exist yet — proceed tenant-global
        console.warn('account resolve skipped:', acctErr.message);
      } else if (acct) {
        accountId = acct.id;
        accountName = acct.name;
      }
    }

    const { data: tenant } = await admin.from('tenants').select('name').eq('id', tenantId).single();
    const tenantName = tenant?.name ?? 'this company';

    // ── Conversation + user message ──
    let convId: string | null = conversationId;
    if (!convId) {
      const { data: conv, error: convErr } = await admin
        .from('de_conversations')
        .insert({ tenant_id: tenantId, channel: 'dock' })
        .select('id').single();
      if (convErr) console.error('conversation create failed', convErr.message);
      convId = conv?.id ?? null;
    }
    const endUserTag = [displayName, accountRef ? `account ${accountRef}` : null]
      .filter(Boolean).join(' · ');
    if (convId) {
      await admin.from('de_messages').insert({
        tenant_id: tenantId, conversation_id: convId, role: 'user',
        content: endUserTag ? `[widget · ${endUserTag}] ${question}` : `[widget] ${question}`,
      });
    }

    // ── Retrieval ──
    const { data: docs } = await admin
      .from('knowledge_docs')
      .select('id, title, content, tags')
      .eq('tenant_id', tenantId);

    if (!docs || docs.length === 0) {
      const answer = "I don't have anything to answer from yet — the team is still setting up my knowledge base. Please check back soon.";
      if (convId) {
        await admin.from('de_messages').insert({
          tenant_id: tenantId, conversation_id: convId, role: 'assistant',
          content: answer, confidence: 0, escalated: false,
        });
      }
      return json({ conversation_id: convId, answer, confidence: 0, sources: [], needs_escalation: false, no_docs: true });
    }

    const top = rankDocs(question, docs as KDoc[]);
    let used = 0;
    const contextParts: string[] = [];
    for (const d of top) {
      const budget = MAX_CONTEXT_CHARS - used;
      if (budget <= 0) break;
      const bodyText = d.content.slice(0, budget);
      contextParts.push(`[Document: ${d.title}]\n${bodyText}`);
      used += bodyText.length + d.title.length;
    }
    const context = contextParts.length > 0
      ? contextParts.join('\n\n---\n\n')
      : 'No documents matched the question.';

    // ── Claude ──
    const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!anthropicKey) {
      return json({ error: 'llm_not_configured', conversation_id: convId });
    }

    const audience = accountName
      ? `You are answering an end user (${displayName || 'an employee'}) at customer account "${accountName}".`
      : `You are answering an end user${displayName ? ` (${displayName})` : ''} of a business customer.`;

    const system = `You are Alex, a Customer Support Digital Employee for ${tenantName}. ${audience} Answer ONLY from the provided knowledge documents. If the documents don't contain the answer, say so plainly and set confidence low. Always output JSON: {"answer": string, "confidence": 0-100, "sources": [doc titles used], "needs_escalation": boolean}. Confidence reflects how well the documents support the answer. Never invent facts.

Knowledge documents:
${context}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: [{ role: 'user', content: question }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('Anthropic error', res.status, detail);
      return json({ error: 'llm_error', status: res.status, conversation_id: convId }, 502);
    }
    const data = await res.json();
    const raw: string = data.content?.[0]?.text ?? '';
    const parsed = parseModelJson(raw);

    const escalate = parsed.needs_escalation || parsed.confidence < ESCALATION_THRESHOLD;

    if (convId) {
      await admin.from('de_messages').insert({
        tenant_id: tenantId, conversation_id: convId, role: 'assistant',
        content: parsed.answer, confidence: parsed.confidence, escalated: escalate,
      });
    }

    if (escalate) {
      const truncated = question.length > 60 ? question.slice(0, 60) + '…' : question;
      const who = endUserTag || 'end user';
      await admin.from('human_tasks').insert({
        tenant_id: tenantId,
        type: 'escalation',
        source: 'de',
        title: `Widget escalation (${who}) — ${truncated}`,
        detail: `End-user question via embedded widget${accountName ? ` from account "${accountName}"` : ''}. Alex's draft answer (confidence ${parsed.confidence}%): ${parsed.answer}`,
        related_table: convId ? 'de_conversations' : null,
        related_id: convId,
      });
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Alex', actor_type: 'de', event_type: 'escalated',
        text: `Widget question from ${who} escalated to human review — "${truncated}"`,
        confidence: parsed.confidence,
      });
    } else {
      await admin.from('activity_events').insert({
        tenant_id: tenantId, actor: 'Alex', actor_type: 'de', event_type: 'resolved',
        text: `Answered a widget question${endUserTag ? ` from ${endUserTag}` : ''} (${parsed.sources.join(', ') || 'no sources cited'})`,
        confidence: parsed.confidence,
      });
    }

    return json({
      conversation_id: convId,
      answer: parsed.answer,
      confidence: parsed.confidence,
      sources: parsed.sources,
      needs_escalation: escalate,
    });
  } catch (err) {
    console.error('widget-ask error:', err);
    return json({ error: String(err) }, 500);
  }
});
