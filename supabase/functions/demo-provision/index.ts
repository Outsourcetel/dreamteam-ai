/**
 * demo-provision — authorized, idempotent provisioning of ONE demo tenant.
 *
 * Service-role/dispatch only. Uses the platform's real provisioning
 * contract (provision_tenant_baseline_internal) and the authorized admin
 * user flow (auth.admin.createUser with email_confirm — confirms this one
 * user, never disables global confirmation). Re-running updates config;
 * it never duplicates a tenant, user, DE, guardrail, or source.
 *
 * The shared demo password arrives in the request body, is used only to
 * mint the auth user, and is never logged or echoed back.
 *
 * POST { spec: {...}, admin_password }  (see caller for the spec shape)
 */
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-dispatch-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

interface Guardrail { rule: string; rule_type: string; pattern?: string; threshold?: number; severity?: string }
interface Spec {
  slug: string; name: string; industry: string; admin_email: string;
  compliance_pack?: string | null;              // hipaa | tcpa_dnc | financial_controls | null
  reply_mode: 'draft' | 'auto';
  persona_name: string; de_description: string; opening_message: string;
  guardrails: Guardrail[];
  sources: Array<{ url: string; title: string; classification: string }>;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const dispatch = Deno.env.get('PLAYBOOK_DISPATCH_SECRET') ?? '';
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!((dispatch && req.headers.get('x-dispatch-secret') === dispatch) || bearer === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
      return json({ error: 'unauthorized' }, 401);
    }
    const { spec } = await req.json() as { spec: Spec };
    if (!spec?.slug || !spec?.admin_email) return json({ error: 'spec.slug, spec.admin_email required' }, 400);
    // The shared demo password lives in Vault, never in a request body.
    const { data: admin_password } = await admin.rpc('read_demo_admin_password');
    if (!admin_password) return json({ error: 'demo_admin_password not set in vault' }, 503);
    const report: Record<string, unknown> = { slug: spec.slug };

    // ── 1) tenant (idempotent by slug) ──
    let tenantId: string;
    const { data: existing } = await admin.from('tenants').select('id').eq('slug', spec.slug).maybeSingle();
    if (existing) {
      tenantId = existing.id;
      await admin.from('tenants').update({ name: spec.name, industry: spec.industry, status: 'active', plan: 'growth' }).eq('id', tenantId);
      report.tenant = 'updated';
    } else {
      const { data: t, error: tErr } = await admin.from('tenants')
        .insert({ name: spec.name, slug: spec.slug, industry: spec.industry, status: 'active', plan: 'growth' })
        .select('id').single();
      if (tErr) return json({ error: `tenant insert: ${tErr.message}` }, 500);
      tenantId = t.id;
      report.tenant = 'created';
      // The real baseline the platform runs for every new tenant.
      await admin.rpc('provision_tenant_baseline_internal', { p_tenant_id: tenantId });
    }
    report.tenant_id = tenantId;

    // ── 2) admin auth user (authorized flow) + tenant-admin profile ──
    const { data: existingUid } = await admin.rpc('get_user_id_by_email', { p_email: spec.admin_email });
    let uid = existingUid as string | null;
    if (!uid) {
      const { data: created, error: cErr } = await admin.auth.admin.createUser({
        email: spec.admin_email, password: admin_password, email_confirm: true,
        user_metadata: { demo: true },
      });
      if (cErr) return json({ error: `createUser: ${cErr.message}` }, 500);
      uid = created.user!.id;
      report.admin_user = 'created';
    } else {
      report.admin_user = 'existing';
    }
    // Profile: exactly tenant_admin on THIS tenant, layer 'tenant' (never platform).
    const { error: pErr } = await admin.from('profiles').upsert({
      user_id: uid, tenant_id: tenantId, role: 'tenant_admin', layer: 'tenant',
      full_name: `${spec.name} Admin`, department: 'Administration', is_active: true,
    }, { onConflict: 'user_id' });
    if (pErr) report.profile_error = pErr.message; else report.profile = 'tenant_admin@' + spec.slug;

    // ── 3) compliance pack (un-toggleable regulatory guardrails) ──
    if (spec.compliance_pack) {
      await admin.rpc('attach_compliance_pack', { p_tenant_id: tenantId, p_pack_key: spec.compliance_pack });
      report.compliance_pack = spec.compliance_pack;
    }

    // ── 4) industry guardrails (idempotent by rule text) ──
    let gAdded = 0;
    for (const g of (spec.guardrails ?? [])) {
      const { data: dup } = await admin.from('guardrail_rules').select('id').eq('tenant_id', tenantId).eq('rule', g.rule).maybeSingle();
      if (dup) continue;
      const { error: gErr } = await admin.from('guardrail_rules').insert({
        tenant_id: tenantId, rule: g.rule, rule_type: g.rule_type,
        pattern: g.pattern ?? null, threshold: g.threshold ?? null,
        severity: g.severity ?? 'blocking', active: true, scope: 'workspace',
      });
      if (!gErr) gAdded++;
    }
    report.guardrails_added = gAdded;

    // ── 5) Support DE (idempotent) via the real archetype hire path ──
    const deName = `${spec.name} Support`;
    let deId: string;
    const { data: existingDe } = await admin.from('digital_employees')
      .select('id').eq('tenant_id', tenantId).eq('catalog_id', 'support_agent').maybeSingle();
    if (existingDe) { deId = existingDe.id; report.de = 'existing'; }
    else {
      const { data: newDe, error: dErr } = await admin.rpc('instantiate_role_archetype', {
        p_tenant_id: tenantId, p_archetype_key: 'support_agent', p_de_name: deName, p_persona_name: spec.persona_name,
      });
      if (dErr) return json({ error: `instantiate DE: ${dErr.message}`, ...report }, 500);
      deId = newDe as string;
      report.de = 'created';
    }
    // Per-tenant persona/description/reply-mode + opening message (in settings).
    await admin.from('digital_employees').update({
      persona_name: spec.persona_name, description: spec.de_description,
      external_reply_mode: spec.reply_mode === 'auto' ? 'auto' : 'draft',
      attributes: { opening_message: spec.opening_message, industry: spec.industry, demo: true },
    }).eq('id', deId);
    report.de_id = deId;
    report.reply_mode = spec.reply_mode;

    // ── 6) source records (metadata now; content ingested separately).
    //      Idempotent by (tenant, external_ref=url); scoped to THIS DE. ──
    let sAdded = 0;
    for (const s of (spec.sources ?? [])) {
      const { data: dup } = await admin.from('knowledge_docs').select('id').eq('tenant_id', tenantId).eq('external_ref', s.url).maybeSingle();
      if (dup) continue;
      const { data: doc, error: sErr } = await admin.from('knowledge_docs').insert({
        tenant_id: tenantId, title: s.title, content: `[pending ingestion] ${s.url}`,
        source: 'connector', external_ref: s.url, visibility: 'scoped', is_current: true,
        tags: [s.classification, 'demo-source', 'ingest-pending'],
      }).select('id').single();
      if (sErr) continue;
      await admin.from('knowledge_doc_scopes').insert({ tenant_id: tenantId, doc_id: doc.id, subject_kind: 'de', subject_id: deId });
      sAdded++;
    }
    report.sources_recorded = sAdded;

    return json({ ok: true, ...report });
  } catch (err) {
    console.error('demo-provision error:', String(err));
    return json({ error: String(err) }, 500);
  }
});
