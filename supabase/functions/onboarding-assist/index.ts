/**
 * onboarding-assist — the Quick Start brain (Wave 4).
 *
 * A tenant admin describes their business + what they want their AI
 * workforce to do; this drives the tenant's "DreamTeam Onboarding
 * Architect" DE through one agentic pass and returns the setup it
 * PROPOSED. Every proposal is a gated action_approval (migration 142):
 * nothing is built until the admin approves it in the UI.
 *
 * Flow: auth (user JWT or service/dispatch) → resolve tenant → find the
 * Architect DE → create a playbook_runs context → invoke
 * agentic-step-execute (service role) with the customer's brief as the
 * goal → collect the gated proposals it created → return them.
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const { description, tenant_id: assertedTenant } = await req.json().catch(() => ({}));
    if (!description || typeof description !== 'string' || description.trim().length < 8) {
      return json({ error: 'description_required', detail: 'Tell us a little about your business and what you want your AI team to handle.' }, 400);
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
    const isServiceRole = jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const isDispatch = dispatchSecret !== '' && headerSecret === dispatchSecret;

    let tenantId: string | null = null;
    if (isServiceRole || isDispatch) {
      tenantId = (typeof assertedTenant === 'string' && /^[0-9a-f-]{36}$/i.test(assertedTenant)) ? assertedTenant : null;
      if (!tenantId) return json({ error: 'tenant_id required for service calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, assertedTenant);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    // The tenant's Onboarding Architect (provisioned by default, migration 143).
    const { data: architect } = await admin.from('digital_employees')
      .select('id, name')
      .eq('tenant_id', tenantId).eq('name', 'DreamTeam Onboarding Architect')
      .maybeSingle();
    if (!architect) {
      return json({ error: 'no_architect', detail: 'The Onboarding Architect is not set up for this workspace yet.' }, 409);
    }

    // Context row for the agentic run (agentic_step_runs.playbook_run_id FK).
    const { data: runCtx } = await admin.from('playbook_runs').insert({ tenant_id: tenantId }).select('id').single();
    if (!runCtx) return json({ error: 'run_context_failed' }, 500);

    const runStart = new Date().toISOString();

    // Give Ada the real archetype catalog so she proposes ready-to-go roles
    // (hire_from_archetype) instead of blank employees the human must
    // configure. When a role matches an archetype, hiring from it is strongly
    // preferred — it applies persona, capabilities, model and compliance packs
    // in one gated step.
    const { data: archetypes } = await admin.from('role_archetypes')
      .select('key, name, domain, description').eq('status', 'active');
    const archetypeCatalog = (archetypes ?? []).length > 0
      ? `\n\nReady-to-go role archetypes you can hire from (use hire_from_archetype with the archetype_key — STRONGLY PREFERRED when a role matches one of these):\n`
        + (archetypes ?? []).map((a: { key: string; name: string; domain: string; description: string }) => `- ${a.key} — ${a.name} (${a.domain}): ${a.description}`).join('\n')
        + `\nFor any role with NO matching archetype, fall back to create_digital_employee.`
      : '';

    const goal = `A customer has described their business and what they want their AI workforce to handle. Propose the setup to onboard them in DreamTeam — create the Digital Employee(s), and (only if clearly needed) a playbook, specialist, or connector. Keep it to the smallest sensible setup that meets the need; name things in the customer's language. Everything you submit is routed to a human for approval — once you've proposed the setup, call mark_goal_complete.${archetypeCatalog}\n\nCustomer's description:\n"""\n${description.trim().slice(0, 4000)}\n"""`;

    const runRes = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/agentic-step-execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      },
      body: JSON.stringify({
        action: 'start', tenant_id: tenantId, de_id: architect.id,
        playbook_run_id: runCtx.id, step_index: 0, goal,
      }),
    });
    const runOut = await runRes.json().catch(() => ({ status: 'failed' }));
    const status = String(runOut.status ?? (runOut.error ? 'failed' : 'unknown'));

    // The proposals this run created — gated executions + their approval tasks.
    const { data: proposals } = await admin
      .from('action_executions')
      .select('id, task_id, request_summary, params, decision, action_definitions(label, description)')
      .eq('tenant_id', tenantId)
      .like('decision', 'human_gated%')
      .gte('created_at', runStart)
      .order('created_at', { ascending: true });

    const shaped = (proposals ?? []).map((p) => {
      const def = (p as { action_definitions?: { label?: string; description?: string } }).action_definitions;
      return {
        execution_id: (p as { id: string }).id,
        task_id: (p as { task_id: string | null }).task_id,
        action_label: def?.label ?? 'Setup step',
        summary: (p as { request_summary: string | null }).request_summary,
        params: (p as { params?: Record<string, unknown> }).params ?? {},
      };
    });

    return json({
      ok: true,
      run_id: runCtx.id,
      status,                    // completed | rate_limited | failed | max_iterations_exceeded | ...
      architect_name: architect.name,
      summary: typeof runOut.summary === 'string' ? runOut.summary : null,
      proposals: shaped,
    });
  } catch (err) {
    console.error('onboarding-assist error:', err);
    return json({ error: String(err) }, 500);
  }
});
