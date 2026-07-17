/**
 * de-work — the autonomy executor. Pulls due items from the DE work
 * queue (migration 156) and works each one with the DE's brain, composing
 * the Wave-1/2 muscles as tools:
 *   recall_memory   -> de_memory_search (155)
 *   remember        -> de_memory_write  (155)
 *   compute         -> compute edge fn  (157, deterministic, receipts)
 *   run_analytics   -> run_analytics_query (159, vetted read-only)
 *   search_knowledge-> hybrid_match_knowledge (046, grounded)
 *   escalate_to_human, mark_done
 * Every turn is written to de_decision_trace (160) so the reasoning is
 * inspectable. On finish the work item is completed (156).
 *
 * v1 is READ/REASON/REMEMBER only — no external writes. Destructive
 * actions still flow through the action registry + Control Fabric gates
 * separately; wiring those tools in here is the next increment (they must
 * carry the destructive/trust/guardrail gating, which this loop does not
 * re-implement).
 *
 * Auth: service role or the dispatch secret (this is a worker/cron).
 * POST { action:'run', tenant_id?, max_items? }  — claim & work due items
 *      { action:'run_one', work_item_id }        — work a specific item (testing)
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAIKey } from '../_shared/aiKeys.ts';
import { embedText } from '../_shared/knowledgeEmbed.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_TURNS = 6;
const MAX_ITEMS_PER_RUN = 3;
const DEFAULT_MODEL = 'claude-sonnet-5';

interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }

async function callAnthropic(apiKey: string, model: string, system: string, messages: Array<{ role: string; content: unknown }>, tools: unknown[]) {
  const backoffs = [1500, 4000];
  let lastStatus = 0, lastBody = '';
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1536, system, messages, tools }),
      });
    } catch (e) { lastStatus = 0; lastBody = String(e); if (attempt < backoffs.length) { await sleep(backoffs[attempt]); continue; } break; }
    if (res.ok) {
      const d = await res.json();
      return { content: (d.content ?? []) as ContentBlock[], stop_reason: String(d.stop_reason ?? 'end_turn'),
               usage: { input_tokens: Number(d.usage?.input_tokens ?? 0), output_tokens: Number(d.usage?.output_tokens ?? 0) } };
    }
    lastStatus = res.status; lastBody = await res.text().catch(() => '');
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < backoffs.length) { await sleep(backoffs[attempt]); continue; }
    break;
  }
  throw new Error(`anthropic_error_${lastStatus}: ${lastBody.slice(0, 200)}`);
}

const TOOLS = [
  { name: 'recall_memory', description: 'Recall what you already know about this task/account from your durable memory.',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, subject_ref: { type: 'string', description: 'optional entity/case id to scope the recall' } }, required: ['query'] } },
  { name: 'search_knowledge', description: 'Search the tenant knowledge base. Answer only from what this returns; cite it.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'compute', description: 'Do exact arithmetic. NEVER calculate numbers yourself — always use this. ops: evaluate{expression,vars}, aggregate{fn,values}, apply_rate{amount,rate_pct}, percent_of{part,whole}, round_currency{amount,dp}, reconcile{expected,actual,tolerance}.',
    input_schema: { type: 'object', properties: { op: { type: 'string' }, expression: { type: 'string' }, vars: { type: 'object' }, fn: { type: 'string' }, values: { type: 'array' }, amount: { type: 'number' }, rate_pct: { type: 'number' }, part: { type: 'number' }, whole: { type: 'number' }, dp: { type: 'number' }, expected: { type: 'number' }, actual: { type: 'number' }, tolerance: { type: 'number' } }, required: ['op'] } },
  { name: 'run_analytics', description: 'Run a vetted analytics query by key. Keys: de_workload{de_id}, action_volume{days}.',
    input_schema: { type: 'object', properties: { key: { type: 'string' }, params: { type: 'object' } }, required: ['key'] } },
  { name: 'remember', description: 'Save an important fact/outcome to durable memory for future tasks.',
    input_schema: { type: 'object', properties: { content: { type: 'string' }, salience: { type: 'number' } }, required: ['content'] } },
  { name: 'escalate_to_human', description: 'Hand off to a human when you cannot safely proceed.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
  { name: 'mark_done', description: 'The ONLY way to finish. Call with a short summary of what you did/found.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

async function dispatchTool(admin: SupabaseClient, tenantId: string, deId: string, subjectRef: string | null, name: string, input: Record<string, unknown>): Promise<{ result: unknown; done?: boolean; escalated?: boolean; summary?: string }> {
  switch (name) {
    case 'recall_memory': {
      const emb = await embedText(String(input.query ?? '').slice(0, 2000));
      const { data } = await admin.rpc('de_memory_search', { p_tenant_id: tenantId, p_de_id: deId, p_query_embedding: emb, p_subject_ref: (input.subject_ref as string) ?? subjectRef ?? null, p_match_count: 5 });
      return { result: (data ?? []).map((m: { content: string }) => m.content) };
    }
    case 'search_knowledge': {
      const emb = await embedText(String(input.query ?? '').slice(0, 2000));
      const { data } = await admin.rpc('hybrid_match_knowledge', { p_tenant_id: tenantId, p_query_text: String(input.query ?? ''), p_query_embedding: emb, p_match_count: 4, p_subject_kind: 'de', p_subject_id: deId });
      return { result: (data ?? []).map((c: { title?: string; content?: string }) => ({ title: c.title, snippet: (c.content ?? '').slice(0, 400) })) };
    }
    case 'compute': {
      const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/compute`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`, apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! }, body: JSON.stringify(input) });
      return { result: await res.json().catch(() => ({ error: 'compute_failed' })) };
    }
    case 'run_analytics': {
      const { data } = await admin.rpc('run_analytics_query', { p_tenant_id: tenantId, p_key: String(input.key ?? ''), p_params: input.params ?? {} });
      return { result: data };
    }
    case 'remember': {
      const emb = await embedText(String(input.content ?? '').slice(0, 4000));
      await admin.rpc('de_memory_write', { p_tenant_id: tenantId, p_de_id: deId, p_content: String(input.content ?? ''), p_embedding: emb, p_subject_kind: subjectRef ? 'case' : 'general', p_subject_ref: subjectRef, p_kind: 'episodic', p_salience: typeof input.salience === 'number' ? input.salience : 0.6, p_source: 'de' });
      return { result: { saved: true } };
    }
    case 'escalate_to_human': {
      await admin.from('human_tasks').insert({ tenant_id: tenantId, type: 'escalation', title: `DE work escalation`, detail: String(input.reason ?? ''), source: 'de', priority: 'high' });
      return { result: { escalated: true }, escalated: true, done: true, summary: `Escalated: ${input.reason}` };
    }
    case 'mark_done':
      return { result: { done: true }, done: true, summary: String(input.summary ?? 'done') };
    default:
      return { result: { error: `unknown tool ${name}` } };
  }
}

async function workItem(admin: SupabaseClient, apiKey: string, item: { id: string; tenant_id: string; de_id: string; title: string; payload: Record<string, unknown> }): Promise<{ id: string; status: string; summary: string; turns: number }> {
  const tenantId = item.tenant_id, deId = item.de_id;
  const { data: de } = await admin.from('digital_employees').select('name, persona_name, model').eq('id', deId).maybeSingle();
  const deName = de?.persona_name || de?.name || 'the digital employee';
  const model = de?.model || DEFAULT_MODEL;
  const goal = item.title + (item.payload?.detail ? `\n\nDetail: ${item.payload.detail}` : '');
  const subjectRef = (item.payload?.subject_ref as string) ?? null;

  const system = `You are ${deName}, a digital employee working a task autonomously.\n`
    + `TASK: ${goal}\n\n`
    + `Rules: Use your tools — never guess a number (use compute), never invent facts (use search_knowledge and cite), recall what you already know first. `
    + `Stay strictly within your guardrails. If you cannot proceed safely or the task needs a human decision, call escalate_to_human. `
    + `When the task is genuinely done (or you've determined it can't be), call mark_done with a short summary. That is the ONLY way to finish.`;
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: goal }];

  let done = false, summary = '', finalStatus = 'done', turn = 0;
  for (turn = 0; turn < MAX_TURNS && !done; turn++) {
    const resp = await callAnthropic(apiKey, model, system, messages, TOOLS);
    messages.push({ role: 'assistant', content: resp.content });
    const toolUses = resp.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) { // model answered with text, no tool -> finish
      summary = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 500) || 'completed';
      done = true; break;
    }
    const toolResults: unknown[] = [];
    for (const tu of toolUses) {
      const out = await dispatchTool(admin, tenantId, deId, subjectRef, tu.name!, tu.input ?? {});
      await admin.from('de_decision_trace').insert({ tenant_id: tenantId, de_id: deId, run_kind: 'work_item', run_ref: item.id, seq: turn, tool: tu.name, inputs: tu.input ?? {}, outputs: out.result as object, rationale: null });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out.result).slice(0, 4000) });
      if (out.done) { done = true; summary = out.summary ?? summary; if (out.escalated) finalStatus = 'waiting_human'; }
    }
    messages.push({ role: 'user', content: toolResults });
  }
  if (!done) { finalStatus = 'failed'; summary = 'max turns reached without completion'; }

  await admin.rpc('complete_de_work_item', { p_id: item.id, p_status: finalStatus, p_result: { summary, turns: turn }, p_error: finalStatus === 'failed' ? summary : null });
  return { id: item.id, status: finalStatus, summary, turns: turn };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    // Auth: dispatch secret or service-role bearer.
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const apiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'llm_not_configured' }, 503);

    const body = await req.json().catch(() => ({}));

    let items: Array<{ id: string; tenant_id: string; de_id: string; title: string; payload: Record<string, unknown> }> = [];
    if (body.action === 'run_one' && body.work_item_id) {
      // Claim the specific item by transitioning it to running.
      const { data } = await admin.from('de_work_items').update({ status: 'running', locked_at: new Date().toISOString(), locked_by: 'de-work', attempts: 1 }).eq('id', body.work_item_id).eq('status', 'queued').select('id, tenant_id, de_id, title, payload');
      items = data ?? [];
    } else {
      const { data } = await admin.rpc('claim_de_work_items', { p_limit: Math.min(MAX_ITEMS_PER_RUN, body.max_items ?? MAX_ITEMS_PER_RUN), p_worker: 'de-work', p_tenant_id: body.tenant_id ?? null });
      items = (data ?? []).map((r: { id: string; tenant_id: string; de_id: string; title: string; payload: Record<string, unknown> }) => ({ id: r.id, tenant_id: r.tenant_id, de_id: r.de_id, title: r.title, payload: r.payload }));
    }

    const results = [];
    for (const it of items) {
      try {
        // Budget gate per tenant before spending on the LLM.
        const { data: budget } = await admin.rpc('check_tenant_ai_budget', { p_tenant_id: it.tenant_id });
        if (budget && budget.allowed === false) {
          await admin.rpc('complete_de_work_item', { p_id: it.id, p_status: 'failed', p_error: 'ai_budget_exceeded', p_retry_delay_seconds: 3600 });
          results.push({ id: it.id, status: 'failed', summary: 'ai_budget_exceeded' }); continue;
        }
        results.push(await workItem(admin, apiKey, it));
      } catch (e) {
        await admin.rpc('complete_de_work_item', { p_id: it.id, p_status: 'failed', p_error: String(e).slice(0, 300) });
        results.push({ id: it.id, status: 'failed', summary: String(e).slice(0, 200) });
      }
    }
    return json({ worked: results.length, results });
  } catch (err) {
    console.error('de-work error:', err);
    return json({ error: String(err) }, 500);
  }
});
