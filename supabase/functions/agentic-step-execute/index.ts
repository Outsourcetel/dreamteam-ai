/**
 * agentic-step-execute — the "agentic step" playbook primitive's brain.
 *
 * A bounded Anthropic tool-use loop: given a goal, the model decides
 * what to do next (search knowledge, call a connector-backed action,
 * ask a human, or declare the goal complete), observes the result, and
 * decides again — up to hard, tenant-configurable limits. This is the
 * one place on the platform where a Digital Employee genuinely adapts
 * instead of following a pre-authored script.
 *
 * THE CENTRAL SAFETY GUARANTEE: every tool that can write or act
 * routes through connector-hub's execute_action — the EXACT SAME call
 * every deterministic connector_action playbook step already uses.
 * This loop is a smarter CALLER of that pipeline, not a parallel
 * safety system. destructive-always-gates -> guardrail-always-wins ->
 * trust-narrows-within-guardrails composes automatically; this file
 * contains zero new gating logic.
 *
 * NON-BLOCKING GATES (see playbook-execute's agentic_step case for the
 * full rationale): when a tool call is gated, the loop is told the
 * action is pending — it keeps reasoning rather than pausing. This
 * mirrors how a deterministic connector_action step already behaves.
 *
 * HARD STOPS (checked BEFORE every model call, not after): max
 * iterations, max tokens, max cost, max consecutive identical tool
 * calls ("no progress"). Every one is a real, independently enforced
 * ceiling — the production incident that grounds this design is real
 * and cited in this session's research: an agent loop with no cost cap
 * burned $16,000-$50,000 in five hours doing exactly what it was told,
 * indefinitely, because nobody told it when to stop.
 *
 * Termination requires an explicit mark_goal_complete tool call, never
 * a bare end_turn — so "done" is always an auditable, intentional
 * decision, not an assumption this code makes on the model's behalf.
 *
 * DORMANT-HONEST: mirrors specialist-consult/de-answer/eval-run exactly
 * — no ANTHROPIC_API_KEY, no reasoning. Every other piece (tool
 * resolution against real data_access_grants, policy loading, the run
 * row itself) is real and independently verifiable today; a
 * 'blocked_llm' row is persisted so the plumbing is provably exercised
 * even while dormant, same discipline as spec_consultations.
 *
 * Actions:
 *   { action: 'start', tenant_id, de_id, playbook_run_id, step_index, goal }
 *     Creates a fresh agentic_step_runs row and runs the loop to a
 *     terminal state in this one call.
 *
 * Auth: caller JWT -> tenant; or service-role key + body.tenant_id
 * (the playbook-execute call path, same convention as every other
 * server-triggered edge function on this platform).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { embedText } from '../_shared/knowledgeEmbed.ts';
import { getAIKey } from '../_shared/aiKeys.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const DEFAULT_MODEL = 'claude-sonnet-5';
const MAX_TURNS_HARD_CEILING = 40; // absolute backstop even if a policy misconfigures a huge max_iterations

// Rough blended $/million-token rates used ONLY for the cost budget
// circuit breaker (not billing) — matched by model-name substring,
// falling back to a conservative default for anything unrecognized so
// the breaker never silently under-counts an unknown model's cost.
const PRICING: Array<{ match: string; inPerM: number; outPerM: number }> = [
  { match: 'opus', inPerM: 15, outPerM: 75 },
  { match: 'sonnet', inPerM: 3, outPerM: 15 },
  { match: 'haiku', inPerM: 0.8, outPerM: 4 },
];
function estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const rate = PRICING.find((p) => model.toLowerCase().includes(p.match)) ?? { inPerM: 5, outPerM: 25 };
  const dollars = (inputTokens * rate.inPerM + outputTokens * rate.outPerM) / 1_000_000;
  return Math.round(dollars * 100 * 100) / 100; // cents, 2dp
}

interface Policy {
  max_iterations: number;
  max_tokens: number;
  max_cost_cents: number;
  max_no_progress_iterations: number;
  enabled: boolean;
}
const POLICY_DEFAULTS: Policy = {
  max_iterations: 15, max_tokens: 100000, max_cost_cents: 500, max_no_progress_iterations: 3, enabled: true,
};

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

interface AnthropicTool { name: string; description: string; input_schema: Record<string, unknown>; connector_id?: string; action_key?: string; destructive?: boolean }
interface ContentBlock { type: string; [k: string]: unknown }

async function persistMessage(
  admin: SupabaseClient, runId: string, turnIndex: number, role: 'user' | 'assistant' | 'tool_result', content: unknown,
) {
  await admin.from('agentic_step_messages').insert({ agentic_step_run_id: runId, turn_index: turnIndex, role, content });
}

async function callAnthropic(
  apiKey: string, model: string, system: string, messages: Array<{ role: string; content: unknown }>, tools: AnthropicTool[],
): Promise<{ content: ContentBlock[]; stop_reason: string; usage: { input_tokens: number; output_tokens: number } }> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model, max_tokens: 2048, system, messages,
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`anthropic_error_${res.status}: ${errBody.slice(0, 300)}`);
  }
  const data = await res.json();
  return {
    content: (data.content ?? []) as ContentBlock[],
    stop_reason: String(data.stop_reason ?? 'end_turn'),
    usage: { input_tokens: Number(data.usage?.input_tokens ?? 0), output_tokens: Number(data.usage?.output_tokens ?? 0) },
  };
}

async function callExecuteAction(
  tenantId: string, deId: string, connectorId: string, actionKey: string, params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      },
      body: JSON.stringify({
        action: 'execute_action', connector_id: connectorId, tenant_id: tenantId,
        subject_kind: 'de', subject_id: deId, action_key: actionKey, params,
      }),
    });
    return await res.json().catch(() => ({ error: 'bad_response' }));
  } catch (e) {
    return { error: `execute_action call failed: ${String(e).slice(0, 160)}` };
  }
}

async function searchKnowledge(admin: SupabaseClient, tenantId: string, deId: string, query: string): Promise<string> {
  if (!query.trim()) return 'No query provided.';
  const qEmb = await embedText(query);
  const { data: chunks, error } = await admin.rpc('hybrid_match_knowledge', {
    p_tenant_id: tenantId, p_query_text: query, p_account_id: null, p_query_embedding: qEmb,
    p_match_count: 5, p_subject_kind: 'de', p_subject_id: deId,
  });
  if (error || !Array.isArray(chunks) || chunks.length === 0) {
    return 'No matching knowledge found.';
  }
  return (chunks as Array<{ doc_title: string; content: string }>)
    .map((c, i) => `[${i + 1}] ${c.doc_title}: ${String(c.content ?? '').slice(0, 300)}`)
    .join('\n');
}

const STATIC_TOOLS: AnthropicTool[] = [
  {
    name: 'search_knowledge',
    description: "Search this tenant's uploaded/ingested knowledge base for information relevant to a question.",
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] },
  },
  {
    name: 'ask_human',
    description: 'Create a task for a human to answer a question you cannot resolve on your own. This does not pause you — a task is created for visibility and you should keep working on the goal as best you can.',
    input_schema: { type: 'object', properties: { question: { type: 'string', description: 'The question for a human' } }, required: ['question'] },
  },
  {
    name: 'mark_goal_complete',
    description: 'Call this when the goal has been accomplished (or you have determined it cannot be, after genuinely trying) — this is the ONLY way to end the task. Do not simply stop responding.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'One or two sentences on what was accomplished (or why it could not be)' } },
      required: ['summary'],
    },
  },
];

async function markTerminal(
  admin: SupabaseClient, runId: string, status: string, result: Record<string, unknown>,
) {
  await admin.from('agentic_step_runs')
    .update({ status, result, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', runId);
}

async function runLoop(
  admin: SupabaseClient, tenantId: string, runId: string, goal: string,
  deName: string, model: string, escalationModel: string, escalationThreshold: number | null,
  tools: AnthropicTool[], policy: Policy, deId: string, apiKey: string,
): Promise<Record<string, unknown>> {
  const system = `You are ${deName}, a digital employee. Your goal for this task: ${goal}\n\n`
    + `Use the tools available to you to accomplish the goal — search knowledge, take actions in connected systems, or ask a human if you're stuck. `
    + `Any action that could affect an external system is automatically checked against this company's safety rules; if one requires human approval, it will be routed there for review and you should decide how to proceed without waiting for the outcome. `
    + `When the goal is accomplished (or you've genuinely determined it cannot be), call mark_goal_complete with a short summary — that is the only way to finish.`;

  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: goal }];
  await persistMessage(admin, runId, 0, 'user', goal);

  let turnIndex = 1;
  let noProgressCount = 0;
  let lastSignature: string | null = null;

  for (let hardTurn = 0; hardTurn < MAX_TURNS_HARD_CEILING; hardTurn++) {
    const { data: fresh } = await admin.from('agentic_step_runs')
      .select('iteration_count, tokens_used, cost_used_cents').eq('id', runId).single();
    const iterationCount = Number(fresh?.iteration_count ?? 0);
    const tokensUsed = Number(fresh?.tokens_used ?? 0);
    const costUsed = Number(fresh?.cost_used_cents ?? 0);

    if (iterationCount >= policy.max_iterations) {
      const result = { reason: 'max_iterations_exceeded', iterations: iterationCount };
      await markTerminal(admin, runId, 'max_iterations_exceeded', result);
      return { status: 'max_iterations_exceeded', agentic_step_run_id: runId };
    }
    if (tokensUsed >= policy.max_tokens) {
      const result = { reason: 'token_budget_exceeded', tokens_used: tokensUsed };
      await markTerminal(admin, runId, 'budget_exceeded', result);
      return { status: 'budget_exceeded', agentic_step_run_id: runId };
    }
    if (costUsed >= policy.max_cost_cents) {
      const result = { reason: 'cost_budget_exceeded', cost_used_cents: costUsed };
      await markTerminal(admin, runId, 'budget_exceeded', result);
      return { status: 'budget_exceeded', agentic_step_run_id: runId };
    }

    const useModel = (escalationThreshold != null && iterationCount >= escalationThreshold) ? escalationModel : model;
    let resp;
    try {
      resp = await callAnthropic(apiKey, useModel, system, messages, tools);
    } catch (e) {
      await markTerminal(admin, runId, 'failed', { reason: 'model_call_failed', detail: String(e).slice(0, 300) });
      return { status: 'failed', agentic_step_run_id: runId };
    }

    const costThisTurn = estimateCostCents(useModel, resp.usage.input_tokens, resp.usage.output_tokens);
    await admin.from('agentic_step_runs').update({
      iteration_count: iterationCount + 1,
      tokens_used: tokensUsed + resp.usage.input_tokens + resp.usage.output_tokens,
      cost_used_cents: costUsed + costThisTurn,
      updated_at: new Date().toISOString(),
    }).eq('id', runId);

    messages.push({ role: 'assistant', content: resp.content });
    await persistMessage(admin, runId, turnIndex++, 'assistant', resp.content);

    if (resp.stop_reason !== 'tool_use') {
      const nudge = 'If the goal is accomplished, call mark_goal_complete with a summary. Otherwise keep working using the available tools.';
      messages.push({ role: 'user', content: nudge });
      await persistMessage(admin, runId, turnIndex++, 'user', nudge);
      continue;
    }

    const toolUses = resp.content.filter((b) => b.type === 'tool_use') as Array<{ id: string; name: string; input: Record<string, unknown> }>;
    const signature = JSON.stringify(toolUses.map((t) => ({ name: t.name, input: t.input })));
    if (signature === lastSignature) {
      noProgressCount++;
    } else {
      noProgressCount = 0;
      lastSignature = signature;
    }
    if (noProgressCount >= policy.max_no_progress_iterations) {
      await markTerminal(admin, runId, 'no_progress', { reason: 'repeated_identical_tool_call', tool_call: signature.slice(0, 500) });
      return { status: 'no_progress', agentic_step_run_id: runId };
    }

    const toolResults: ContentBlock[] = [];
    for (const tu of toolUses) {
      if (tu.name === 'mark_goal_complete') {
        const summary = String(tu.input?.summary ?? 'Goal reached.');
        await markTerminal(admin, runId, 'completed', { summary });
        return { status: 'completed', agentic_step_run_id: runId, summary };
      }
      if (tu.name === 'search_knowledge') {
        const result = await searchKnowledge(admin, tenantId, deId, String(tu.input?.query ?? ''));
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
        continue;
      }
      if (tu.name === 'ask_human') {
        const question = String(tu.input?.question ?? '').slice(0, 500);
        const { data: task } = await admin.from('human_tasks').insert({
          tenant_id: tenantId, type: 'escalation', source: 'de',
          title: `${deName} needs input — agentic step`,
          detail: question, related_table: 'agentic_step_runs', related_id: runId,
        }).select('id').single();
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `A task was created for a human (task ${task?.id ?? 'unknown'}). Continue working on the goal — you will not see their answer in this run.` });
        continue;
      }
      const toolDef = tools.find((t) => t.name === tu.name);
      if (!toolDef || !toolDef.connector_id || !toolDef.action_key) {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Unknown tool "${tu.name}".`, is_error: true });
        continue;
      }
      const execRes = await callExecuteAction(tenantId, deId, toolDef.connector_id, toolDef.action_key, tu.input);
      if (execRes.error === 'access_denied') {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Access denied: ${execRes.detail ?? 'no permission'}`, is_error: true });
      } else if (execRes.ok && execRes.gated) {
        await admin.from('agentic_step_runs').update({ last_gated_human_task_id: execRes.task_id ?? null }).eq('id', runId);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `This action requires human approval and has been routed for review (task created). You will not see the outcome in this run — decide how to proceed assuming it may or may not be approved.` });
      } else if (execRes.ok) {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: String(execRes.receipt ?? 'Action completed.') });
      } else {
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `Action failed: ${execRes.error ?? execRes.detail ?? 'unknown error'}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
    await persistMessage(admin, runId, turnIndex++, 'tool_result', toolResults);
  }

  await markTerminal(admin, runId, 'max_iterations_exceeded', { reason: 'hard_turn_ceiling' });
  return { status: 'max_iterations_exceeded', agentic_step_run_id: runId };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? 'start';
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin.from('profiles').select('tenant_id').eq('user_id', userData.user.id).single();
      tenantId = profile?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    if (action !== 'start') return json({ error: 'unknown_action' }, 400);

    const deId = String(body.de_id ?? '');
    const playbookRunId = String(body.playbook_run_id ?? '');
    const stepIndex = Number(body.step_index ?? -1);
    const goal = String(body.goal ?? '').trim();
    if (!deId || !playbookRunId || stepIndex < 0 || !goal) {
      return json({ error: 'de_id, playbook_run_id, step_index, goal are all required' }, 400);
    }

    const { data: policyRow } = await admin.from('agentic_step_policies')
      .select('max_iterations, max_tokens, max_cost_cents, max_no_progress_iterations, enabled')
      .eq('tenant_id', tenantId).maybeSingle();
    const policy: Policy = policyRow ? (policyRow as Policy) : POLICY_DEFAULTS;

    const { data: deRow } = await admin.from('digital_employees')
      .select('id, name, model_id, escalation_model_id, escalation_threshold')
      .eq('id', deId).eq('tenant_id', tenantId).maybeSingle();
    if (!deRow) return json({ error: 'digital_employee_not_found' }, 404);

    const { data: runRow, error: runErr } = await admin.from('agentic_step_runs').insert({
      tenant_id: tenantId, playbook_run_id: playbookRunId, step_index: stepIndex,
      de_id: deId, goal, status: 'running',
    }).select('id').single();
    if (runErr || !runRow) return json({ error: runErr?.message ?? 'agentic_step_run insert failed' }, 500);
    const runId = runRow.id as string;

    if (!policy.enabled) {
      await markTerminal(admin, runId, 'failed', { reason: 'disabled_by_tenant_policy' });
      return json({ status: 'failed', agentic_step_run_id: runId, error: 'disabled_by_tenant_policy' });
    }

    const apiKey = await getAIKey(admin, 'ANTHROPIC_API_KEY');
    if (!apiKey) {
      await markTerminal(admin, runId, 'blocked_llm', { reason: 'llm_not_configured' });
      await audit(admin, tenantId!, deRow.name ?? 'Digital Employee',
        `Agentic step blocked — reasoning not activated (ANTHROPIC_API_KEY) — "${goal.slice(0, 160)}"`,
        'playbook_step', { kind: 'agentic_step_blocked_llm', agentic_step_run_id: runId, playbook_run_id: playbookRunId, step_index: stepIndex });
      return json({ error: 'llm_not_configured', agentic_step_run_id: runId });
    }

    const { data: toolRows } = await admin.rpc('get_agentic_tools_for_de', { p_tenant_id: tenantId, p_de_id: deId });
    const tools: AnthropicTool[] = [...STATIC_TOOLS, ...((toolRows ?? []) as AnthropicTool[])];

    await audit(admin, tenantId!, deRow.name ?? 'Digital Employee',
      `Agentic step started — "${goal.slice(0, 160)}" (${tools.length - STATIC_TOOLS.length} action tool(s) available)`,
      'playbook_step', { kind: 'agentic_step_started', agentic_step_run_id: runId, playbook_run_id: playbookRunId, step_index: stepIndex, tool_count: tools.length });

    const result = await runLoop(
      admin, tenantId!, runId, goal, deRow.name ?? 'Digital employee',
      deRow.model_id || DEFAULT_MODEL, deRow.escalation_model_id || deRow.model_id || DEFAULT_MODEL,
      typeof deRow.escalation_threshold === 'number' ? deRow.escalation_threshold : null,
      tools, policy, deId, apiKey,
    );

    await audit(admin, tenantId!, deRow.name ?? 'Digital Employee',
      `Agentic step ended — ${result.status}${result.summary ? `: ${String(result.summary).slice(0, 200)}` : ''}`,
      'playbook_step', { kind: 'agentic_step_ended', agentic_step_run_id: runId, status: result.status });

    return json(result);
  } catch (err) {
    console.error('agentic-step-execute error:', err);
    return json({ error: String(err) }, 500);
  }
});
