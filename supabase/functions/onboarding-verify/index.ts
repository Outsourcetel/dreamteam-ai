/**
 * onboarding-verify — connector-verified onboarding provisioning
 * (gap-analysis item 10).
 *
 * Every onboarding item today completes the same way regardless of
 * owner_type: a human picks "Done." This function is the other way —
 * for items that opt into a `verify` config (category, op, template,
 * match rule), it actually calls the connected system via
 * connector-hub's deterministic `category_op` (the same no-LLM
 * read-through every other category_op consumer uses — no new adapter
 * code) and only marks the item done when the check genuinely passes.
 * The result is written through `apply_onboarding_verification`
 * (migration 076, service-role only), which stamps `verified_by:
 * 'system'` — an honest, UI-visible distinction from a human's tick.
 *
 * Actions:
 *   { action: 'check_item', tenant_id, project_id, key }
 *     One item, on demand (the project page's "Check now" button).
 *
 *   { action: 'check_due' }
 *     System trigger (pg_cron via invoke_playbook_dispatch,
 *     x-dispatch-secret) — every active project, every verify-
 *     configured item still pending/in_progress/blocked, across every
 *     tenant. Same shape as poll_de_work_sources: independent per item,
 *     one failure never blocks the rest.
 *
 * Access: every check runs AS a resolved DE subject through
 * resolve_access (connector-hub's normal default-deny grant check) —
 * verification is not a bypass of data access rules. Absent an
 * explicit "which DE governs this onboarding" concept (out of scope
 * for this build), the acting subject is the tenant's earliest-created
 * digital_employees row — the SAME fallback playbook-execute's
 * resolveRunDeId already uses when no DE is explicitly assigned. If a
 * tenant has no DE at all, verification is honestly skipped (never
 * silently run without a subject — that would bypass grants entirely).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveTenantWithRemoteAccess } from '../_shared/resolveTenant.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface VerifyConfig {
  category: string; op: string;
  query_template?: string; ref_template?: string;
  match: 'exists' | 'contains'; contains_text?: string;
}
interface ItemDef { key: string; label: string; owner_type: string; verify?: VerifyConfig }
interface HubItem { external_ref: string; title: string; snippet: string; url: string | null }

function renderTemplate(tpl: string, accountName: string): string {
  return tpl.replace(/\{\{account\.name\}\}/g, accountName).trim();
}

async function resolveDeId(admin: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await admin.from('digital_employees')
    .select('id').eq('tenant_id', tenantId)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

async function callCategoryOp(
  tenantId: string, connectorId: string, op: string, params: Record<string, string>, deId: string,
): Promise<{ ok: boolean; items: HubItem[]; error: string | null; detail: string | null }> {
  try {
    const res = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/connector-hub`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      },
      body: JSON.stringify({
        action: 'category_op', connector_id: connectorId, tenant_id: tenantId, op, params,
        subject_kind: 'de', subject_id: deId,
      }),
    });
    const data = await res.json().catch(() => ({}));
    return {
      ok: !!data.ok, items: (data.items ?? []) as HubItem[],
      error: (data.error as string) ?? null, detail: (data.detail as string) ?? null,
    };
  } catch (e) {
    return { ok: false, items: [], error: 'connector_call_failed', detail: String(e).slice(0, 160) };
  }
}

async function audit(
  admin: SupabaseClient, tenantId: string, action: string, category: string, detail: Record<string, unknown>,
) {
  const { error } = await admin.rpc('append_audit_event', {
    p_tenant_id: tenantId, p_actor: 'Onboarding verification', p_actor_type: 'system',
    p_action: action, p_category: category, p_detail: detail,
  });
  if (error) console.error('audit:', error.message);
}

/** One item, fully resolved and checked. Returns a plain-language outcome either way. */
async function checkOneItem(
  admin: SupabaseClient, tenantId: string, projectId: string, accountId: string, def: ItemDef,
): Promise<{ ok: boolean; verified?: boolean; skipped?: string; detail: string }> {
  const verify = def.verify;
  if (!verify) return { ok: false, skipped: 'not_verifiable', detail: 'This item has no automated check configured.' };

  const { data: conn } = await admin.from('connectors')
    .select('id, display_name, provider, category')
    .eq('tenant_id', tenantId).eq('category', verify.category).eq('status', 'connected')
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!conn) {
    return { ok: false, skipped: 'no_connector', detail: `No connected ${verify.category} system to check against.` };
  }

  const deId = await resolveDeId(admin, tenantId);
  if (!deId) {
    return { ok: false, skipped: 'no_de', detail: 'No digital employee available to run this check on behalf of.' };
  }

  const { data: acct } = await admin.from('customer_accounts').select('name').eq('id', accountId).maybeSingle();
  const accountName = (acct?.name as string) ?? '';

  const params: Record<string, string> = {};
  if (verify.query_template) params.query = renderTemplate(verify.query_template, accountName);
  if (verify.ref_template) params.external_ref = renderTemplate(verify.ref_template, accountName);

  const r = await callCategoryOp(tenantId, conn.id, verify.op, params, deId);
  if (r.error === 'access_denied') {
    return { ok: false, skipped: 'access_denied', detail: `The verifying DE does not have permission to read ${conn.display_name || conn.provider} — an admin can grant it under Governance → Data Access.` };
  }
  if (!r.ok) {
    return { ok: false, skipped: 'check_failed', detail: `Check failed: ${r.error ?? r.detail ?? 'unknown error'}` };
  }

  let verified: boolean;
  let matchDetail: string;
  if (verify.match === 'exists') {
    verified = r.items.length > 0;
    matchDetail = verified
      ? `Found ${r.items.length} matching record(s) via ${verify.category}.${verify.op} on ${conn.display_name || conn.provider}.`
      : `No matching record via ${verify.category}.${verify.op} on ${conn.display_name || conn.provider} — not yet provisioned.`;
  } else {
    const needle = (verify.contains_text ?? '').toLowerCase();
    const hit = r.items.find((i) => `${i.title} ${i.snippet}`.toLowerCase().includes(needle));
    verified = !!hit;
    matchDetail = verified
      ? `Found a record containing "${verify.contains_text}" via ${verify.category}.${verify.op} on ${conn.display_name || conn.provider}.`
      : `No record containing "${verify.contains_text}" via ${verify.category}.${verify.op} on ${conn.display_name || conn.provider} — not yet provisioned.`;
  }

  const applied = await admin.rpc('apply_onboarding_verification', {
    p_project_id: projectId, p_key: def.key, p_verified: verified, p_detail: matchDetail,
  });
  const appliedData = (applied.data ?? {}) as { changed?: boolean; error?: string };
  if (appliedData.error) {
    return { ok: false, skipped: appliedData.error, detail: `Verified=${verified} but could not be recorded: ${appliedData.error}` };
  }

  await audit(admin, tenantId,
    `Onboarding check — "${def.label}": ${verified ? 'VERIFIED' : 'not yet'} — ${matchDetail}`,
    'connector_action',
    { kind: 'onboarding_verify_check', project_id: projectId, item_key: def.key, connector_id: conn.id, category: verify.category, op: verify.op, verified });

  return { ok: true, verified, detail: matchDetail };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action ?? 'check_item';
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');

    // ── check_due: system trigger only (pg_cron dispatch or service role) ──
    if (action === 'check_due') {
      const dispatchSecret = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
      const headerSecret = req.headers.get('x-dispatch-secret') ?? '';
      const isCron = !!dispatchSecret && headerSecret === dispatchSecret;
      const isServiceRole = jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!isCron && !isServiceRole) return json({ error: 'unauthorized' }, 401);

      const { data: projects } = await admin.from('onboarding_projects')
        .select('id, tenant_id, account_id, template_version_id, items_state')
        .eq('status', 'active');

      let checked = 0, verified = 0, skipped = 0;
      for (const proj of (projects ?? []) as Array<{ id: string; tenant_id: string; account_id: string; template_version_id: string; items_state: Array<{ key: string; status: string }> }>) {
        const { data: ver } = await admin.from('onboarding_template_versions')
          .select('items').eq('id', proj.template_version_id).maybeSingle();
        const defs = ((ver?.items ?? []) as ItemDef[]).filter((d) => d.verify);
        if (defs.length === 0) continue;
        for (const def of defs) {
          const st = proj.items_state.find((s) => s.key === def.key);
          if (!st || !['pending', 'in_progress', 'blocked'].includes(st.status)) continue;
          try {
            const r = await checkOneItem(admin, proj.tenant_id, proj.id, proj.account_id, def);
            checked++;
            if (r.verified) verified++;
            if (r.skipped) skipped++;
          } catch (e) {
            console.error('onboarding-verify check_due item error:', proj.id, def.key, e);
          }
        }
      }
      return json({ ok: true, projects: (projects ?? []).length, checked, verified, skipped });
    }

    // ── check_item: tenant-scoped, on-demand ──
    let tenantId: string | null = null;
    if (jwt === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      tenantId = body?.tenant_id ?? null;
      if (!tenantId) return json({ error: 'tenant_id required for service-role calls' }, 400);
    } else {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);
      const { data: profile } = await admin.from('profiles').select('tenant_id, layer').eq('user_id', userData.user.id).single();
      tenantId = await resolveTenantWithRemoteAccess(admin, userData.user.id, profile?.tenant_id, profile?.layer, body?.tenant_id);
      if (!tenantId) return json({ error: 'no_tenant' }, 403);
    }

    const projectId = String(body.project_id ?? '');
    const key = String(body.key ?? '');
    if (!projectId || !key) return json({ error: 'project_id_and_key_required' }, 400);

    const { data: proj } = await admin.from('onboarding_projects')
      .select('id, tenant_id, account_id, template_version_id, status')
      .eq('id', projectId).eq('tenant_id', tenantId).maybeSingle();
    if (!proj) return json({ error: 'project_not_found' }, 404);
    if (proj.status !== 'active') return json({ error: 'project_not_active' }, 200);

    const { data: ver } = await admin.from('onboarding_template_versions')
      .select('items').eq('id', proj.template_version_id).maybeSingle();
    const def = ((ver?.items ?? []) as ItemDef[]).find((d) => d.key === key);
    if (!def) return json({ error: 'item_not_found' }, 404);

    const result = await checkOneItem(admin, tenantId!, proj.id, proj.account_id, def);
    return json(result);
  } catch (err) {
    console.error('onboarding-verify error:', err);
    return json({ error: String(err) }, 500);
  }
});
