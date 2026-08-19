// G-6 — the probe Workstream C owed: attack production as ANON.
//
// docs/50 attacked as a real authenticated user of another tenant and found no
// holes. It never asked the prior question: what can someone with only the
// publishable key — the internet — reach? "authenticated = the internet" is
// this project's own recorded lesson (mig 365); anon is the layer below it.
//
// Read-only by construction except where a write is the thing being tested, and
// every write targets a row that must be refused. Nothing is created.
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config({ path: '.env' });

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const anon = createClient(URL, ANON, { auth: { persistSession: false } });

let holes = 0, checks = 0;
const SAFE = (n, d) => { checks++; console.log(` SAFE  ${n} — ${d}`); };
const HOLE = (n, d) => { checks++; holes++; console.log(` ⚠HOLE ${n} — ${d}`); };

// ── 1. Can anon read anything at all? ────────────────────────────────────
const TABLES = [
  'tenants', 'profiles', 'digital_employees', 'de_conversations', 'de_messages',
  'human_tasks', 'knowledge_docs', 'knowledge_doc_chunks', 'audit_events',
  'connectors', 'connector_secrets', 'action_executions', 'de_token_usage',
  'guardrail_rules', 'trust_policies', 'platform_config', 'widget_keys',
  'end_user_sessions', 'customer_account_contacts', 'schema_migrations',
];
for (const t of TABLES) {
  const { data, error } = await anon.from(t).select('*').limit(3);
  if (error) SAFE(`read ${t}`, `refused: ${error.message.slice(0, 48)}`);
  else if ((data?.length ?? 0) === 0) SAFE(`read ${t}`, '0 rows');
  else HOLE(`read ${t}`, `${data.length} row(s) READABLE BY THE INTERNET`);
}

// ── 2. Can anon write? Every one of these must be refused. ───────────────
const WRITES = [
  ['tenants', { name: 'anon-probe', slug: 'anon-probe-should-not-exist' }],
  ['profiles', { full_name: 'anon probe' }],
  ['human_tasks', { type: 'escalation', title: 'anon probe', source: 'de' }],
  ['knowledge_docs', { title: 'anon probe', content: 'x', source: 'paste' }],
  ['audit_events', { actor: 'anon', actor_type: 'human', action: 'anon probe', category: 'access_control' }],
  ['widget_keys', { key_hash: 'anon-probe', label: 'anon probe', active: true }],
];
for (const [t, row] of WRITES) {
  const { data, error } = await anon.from(t).insert(row).select('*');
  if (error) SAFE(`write ${t}`, `refused: ${error.message.slice(0, 48)}`);
  else if ((data?.length ?? 0) === 0) SAFE(`write ${t}`, '0 rows written (RLS)');
  else HOLE(`write ${t}`, `INSERTED ${data.length} row(s) AS ANON`);
}

// ── 3. SECDEF RPCs an anonymous caller might reach ───────────────────────
const RPCS = [
  ['complete_signup', { p_org_name: 'anon probe', p_industry: 'x' }],
  ['decide_human_task', { p_task_id: '00000000-0000-0000-0000-000000000000', p_decision: 'approved' }],
  ['delete_tenant', { p_tenant_id: '00000000-0000-0000-0000-000000000000', p_confirm_slug: 'x' }],
  ['forget_end_user', { p_tenant_id: '00000000-0000-0000-0000-000000000000', p_end_user_ref: 'x' }],
  ['create_tenant_api_key', { p_tenant_id: '00000000-0000-0000-0000-000000000000', p_name: 'anon', p_scopes: [] }],
  ['get_de_cost_metrics', { p_tenant_id: '5bb802e1-8e92-4eef-9a7a-ac348785d43f' }],
  ['calculate_tenant_monthly_cost', { p_tenant_id: '5bb802e1-8e92-4eef-9a7a-ac348785d43f' }],
  ['is_platform_admin', {}],
  ['auth_tenant_id', {}],
];
for (const [fn, args] of RPCS) {
  const { data, error } = await anon.rpc(fn, args);
  if (error) SAFE(`rpc ${fn}`, `refused: ${error.message.slice(0, 52)}`);
  else if (data === null || data === false || (Array.isArray(data) && !data.length)) SAFE(`rpc ${fn}`, `null/empty (${JSON.stringify(data)})`);
  else HOLE(`rpc ${fn}`, `RETURNED ${JSON.stringify(data).slice(0, 70)}`);
}

// ── 4. The storage privilege A-1 named, from the outside ─────────────────
{
  const r = await fetch(`${URL}/rest/v1/objects?select=id&limit=1`, { headers: { apikey: ANON } });
  r.status === 404 || r.status === 401 || r.status === 403
    ? SAFE('storage.objects via PostgREST', `HTTP ${r.status} — schema not exposed`)
    : HOLE('storage.objects via PostgREST', `HTTP ${r.status} — REACHABLE`);
  checks++;
}

console.log(`\n${checks} checks · ${holes === 0 ? 'ANON PERIMETER HELD — 0 holes' : `⚠ ${holes} HOLE(S)`}`);
process.exit(holes === 0 ? 0 : 1);
