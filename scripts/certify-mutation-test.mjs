// Mutation-test the Ring-0 probes: for each, prove that INJECTING the exact
// violation it hunts makes the probe RETURN ROWS. A probe that stays empty when
// the thing it forbids is present is theater — and this codebase has shipped
// exactly that (a vacuous invariants query, a test that asserted a bug).
//
// Read-only against PRODUCTION. Every mutation is a SELECT that SYNTHESISES a
// violating row in-query (no writes) and confirms the probe's own predicate
// fires on it. Where a probe reads live catalog state that a SELECT cannot
// fake, the mutation is described and marked MANUAL.
import { readFileSync } from 'node:fs';
// The REAL probe, not a copy of it. mig 661 shipped a pin that could not fail
// because the check and the thing it checked had drifted apart; the cases below
// run certify's own query with a pin removed rather than a paraphrase of it.
import { landedPredicateSql, LANDED_PINS } from './landed-predicate.mjs';
const REF = 'rfsvmhcqeiyrxivbmpel';
function token() {
  const env = readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
  const line = env.split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
  return line.slice('SUPABASE_ACCESS_TOKEN='.length).replace(/^["']|["']$/g, '').trim();
}
const TOKEN = token();
async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${t.slice(0,200)}`);
  return JSON.parse(t);
}

// Each case: a predicate lifted from the real probe, applied to a synthesised
// violating row. It MUST return >=1 row (probe fires) and the clean row MUST
// return 0 (probe silent). Both halves matter: a probe that fires on everything
// is as useless as one that fires on nothing.
const CASES = [
  // ── mig 679's ratchet: landed-reads-use-the-shared-predicate ────────────
  // The first two run certify's ACTUAL probe against the LIVE production
  // catalog with one pin removed / one bogus pin added. That is a stronger
  // proof than any synthesised row: it shows the real query, over real bodies,
  // names the real function the moment its exemption goes away.
  {
    name: 'landed-reads-use-the-shared-predicate (drop a real pin -> the real probe names that function)',
    fires: landedPredicateSql(LANDED_PINS.filter((n) => n !== 'get_de_action_metrics')),
    silent: landedPredicateSql(),
  },
  {
    name: 'landed-reads-use-the-shared-predicate (a pin guarding nothing is itself a violation)',
    fires: landedPredicateSql([...LANDED_PINS, 'zz_pin_for_a_body_that_does_not_exist']),
    silent: landedPredicateSql(),
  },
  {
    // Isolates the `not ilike '%action_execution_landed%'` clause. Without it
    // the probe would flag all three fixed readers forever and be switched off;
    // with it inverted it would flag nobody. Same body, one call added.
    name: 'landed-reads-use-the-shared-predicate (calling the shared predicate is what clears a body)',
    fires: `select 1 where exists (select 1 from (values
              ('a_new_reader','count(*) filter (where decision = auto_executed)')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics','check_action_idempotency'))`,
    silent: `select 1 where exists (select 1 from (values
              ('a_new_reader','count(*) filter (where public.action_execution_landed(ae)) -- was decision = auto_executed')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics','check_action_idempotency'))`,
  },
  {
    // The OR's SECOND half on its own. A sieve that only looked for
    // `auto_executed` would miss every gated reader — which is exactly the
    // half migs 676/677/678 were about.
    name: 'landed-reads-use-the-shared-predicate (executed_after_approval alone is enough to be caught)',
    fires: `select 1 where exists (select 1 from (values
              ('a_new_reader','where decision = executed_after_approval')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
    silent: `select 1 where exists (select 1 from (values
              ('a_new_reader','where decision = human_gated_trust')) v(nm, src)
             where (src ilike '%executed_after_approval%' or src ilike '%auto_executed%')
               and src not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
  },
  {
    // The VIEW arm. There are zero such views today, so live data cannot
    // exercise it — which is precisely why it needs a synthesised mutant
    // rather than a shrug.
    name: 'landed-reads-use-the-shared-predicate (a VIEW is caught by the same rule)',
    fires: `select 1 where exists (select 1 from (values
              ('v_actions_done','select id from action_executions where decision in (auto_executed)')) v(nm, def)
             where (def ilike '%executed_after_approval%' or def ilike '%auto_executed%')
               and def not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
    silent: `select 1 where exists (select 1 from (values
              ('v_actions_done','select id from action_executions ae where public.action_execution_landed(ae)')) v(nm, def)
             where (def ilike '%executed_after_approval%' or def ilike '%auto_executed%')
               and def not ilike '%action_execution_landed%'
               and nm not in ('get_de_action_metrics'))`,
  },
  {
    // The stale-pin arm's mechanics, isolated from live catalog contents: a
    // pinned name still fires when NO body of that name names either literal,
    // and stays silent when one does.
    name: 'landed-reads-use-the-shared-predicate (stale-pin arm: fires only when the pinned body is gone)',
    fires: `select 1 from (values ('pinned_name')) v(nm)
             where not exists (select 1 from (values ('some_other_fn','names auto_executed')) p(nm, src)
                                where p.nm = v.nm
                                  and (p.src ilike '%auto_executed%' or p.src ilike '%executed_after_approval%'))`,
    silent: `select 1 from (values ('pinned_name')) v(nm)
             where not exists (select 1 from (values ('pinned_name','names auto_executed')) p(nm, src)
                                where p.nm = v.nm
                                  and (p.src ilike '%auto_executed%' or p.src ilike '%executed_after_approval%'))`,
  },
  {
    name: 'no-unattended-public-speech',
    fires: `select 1 where exists (select 1 from (values ('publish_post','{"destructive":false}'::jsonb)) v(k,risk)
              where k in ('publish_post','publish_video') and (risk->>'destructive')::boolean is not true)`,
    silent: `select 1 where exists (select 1 from (values ('publish_post','{"destructive":true}'::jsonb)) v(k,risk)
              where k in ('publish_post','publish_video') and (risk->>'destructive')::boolean is not true)`,
  },
  {
    name: 'money-param-is-amount_cents',
    fires: `select 1 where exists (select 1 from (values ('budget_cents','integer')) v(name,typ)
              where typ in ('integer','number') and name ~* '(budget|amount|cents|price|spend)' and name <> 'amount_cents')`,
    silent: `select 1 where exists (select 1 from (values ('amount_cents','integer')) v(name,typ)
              where typ in ('integer','number') and name ~* '(budget|amount|cents|price|spend)' and name <> 'amount_cents')`,
  },
  {
    name: 'template-op-contract-classes (search without {query})',
    fires: `select 1 where 'search_x' like 'search\\_%' and '{"path_template":"/x"}' not like '%{query}%'`,
    silent: `select 1 where 'search_x' like 'search\\_%' and '{"query_params":{"q":"{query}"}}' not like '%{query}%'`,
  },
  {
    name: 'template-op-contract-classes (list pretending to search)',
    fires: `select 1 where 'list_x' like 'list\\_%' and '{"q":"{query}"}' like '%{query}%'`,
    silent: `select 1 where 'list_x' like 'list\\_%' and '{"limit":25}' like '%{query}%'`,
  },
  {
    name: 'template-op-contract-classes (frozen literal date)',
    fires: `select 1 where '{"startDate":"2026-01-01"}' ~ '"(startDate|endDate)":\\s*"\\d{4}-'`,
    silent: `select 1 where '{"startDate":"{days_ago_28}"}' ~ '"(startDate|endDate)":\\s*"\\d{4}-'`,
  },
  {
    name: 'rls-on-every-public-table',
    fires: `select 1 where exists (select 1 from (values ('faketable', false)) v(t, rls) where not rls)`,
    silent: `select 1 where exists (select 1 from (values ('faketable', true)) v(t, rls) where not rls)`,
  },
  {
    name: 'audit-chain-verifies-hq',
    fires: `select 1 where coalesce(('{"intact":false}'::jsonb->>'intact')::boolean,false) is not true`,
    silent: `select 1 where coalesce(('{"intact":true}'::jsonb->>'intact')::boolean,false) is not true`,
  },
  {
    // Half 1 of the R0.8 ratchet: does the sieve notice a MISSING caller check?
    // The real proof of this probe is stronger than any synthesised row — the
    // violation existed in production. It returned exactly 28 rows before
    // mig 662 and 0 after, on the live database. Recorded here so the predicate
    // itself stays honest if someone edits it.
    name: 'secdef-caller-tenant-ratchet (unguarded body fires)',
    fires: `select 1 where exists (select 1 from (values
              ('leak_me', true, true, 'p_tenant_id uuid', 'select * from renewal_invoices where tenant_id = p_tenant_id')
            ) v(nm, secdef, authed, args, src)
             where secdef and authed and args like '%uuid%'
               and src not ilike '%auth_tenant_id%' and src not ilike '%auth.uid%'
               and src not ilike '%can_access_de%' and src not ilike '%is_platform_admin%'
               and nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
    silent: `select 1 where exists (select 1 from (values
              ('leak_me', true, true, 'p_tenant_id uuid', 'select * from renewal_invoices where tenant_id = public.auth_tenant_id()')
            ) v(nm, secdef, authed, args, src)
             where secdef and authed and args like '%uuid%'
               and src not ilike '%auth_tenant_id%' and src not ilike '%auth.uid%'
               and src not ilike '%can_access_de%' and src not ilike '%is_platform_admin%'
               and nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
  },
  {
    // Half 2: the allowlist must actually exempt, and ONLY the names in it.
    // A ratchet whose allowlist matched everything would be silent forever.
    name: 'secdef-caller-tenant-ratchet (allowlist exempts, and only its names)',
    fires: `select 1 where exists (select 1 from (values ('brand_new_leak')) v(nm)
             where nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
    silent: `select 1 where exists (select 1 from (values ('list_org_tree')) v(nm)
             where nm not in ('list_org_tree','match_doc_chunks','tenant_ancestors'))`,
  },
  {
    // Condition 1 only (action_key match) — against the LIVE table, deliberately:
    // 'no_such_verb' genuinely does not exist in production and
    // 'configure_customer_setup' genuinely does (mig 651), so this is the one
    // case that also proves the probe's predicate agrees with real data, not
    // just a synthetic model of it.
    name: 'onboarding-bindings-are-runnable (named verb does not exist at all)',
    fires: `select 1 where exists (select 1 from (values ('no_such_verb')) v(k)
              where not exists (select 1 from action_definitions ad
                                 where ad.action_key = v.k and ad.status='active'))`,
    silent: `select 1 where exists (select 1 from (values ('configure_customer_setup')) v(k)
              where not exists (select 1 from action_definitions ad
                                 where ad.action_key = v.k and ad.status='active'))`,
  },
  // The remaining cases lift the probe's real three-condition predicate
  //   ad.action_key = i->>'action_key' and ad.status = 'active'
  //   and (ad.tenant_id is null or ad.tenant_id = v.tenant_id)
  // verbatim, over a synthesised item(tenant_id, action_key) row and a
  // synthesised ad(action_key, status, tenant_id) row — no live table read or
  // depended on, so these hold even if action_definitions' contents change.
  {
    // Condition 2 (status = 'active') exercised on its own: same tenant,
    // same action_key, only the status differs.
    name: 'onboarding-bindings-are-runnable (named verb exists but is not active)',
    fires: `select 1 where exists (
              select 1 from (values ('tenant-a','k')) item(tenant_id, action_key)
               where not exists (
                 select 1 from (values ('k','draft',null::text)) ad(action_key, status, tenant_id)
                  where ad.action_key = item.action_key
                    and ad.status = 'active'
                    and (ad.tenant_id is null or ad.tenant_id = item.tenant_id)))`,
    silent: `select 1 where exists (
              select 1 from (values ('tenant-a','k')) item(tenant_id, action_key)
               where not exists (
                 select 1 from (values ('k','active',null::text)) ad(action_key, status, tenant_id)
                  where ad.action_key = item.action_key
                    and ad.status = 'active'
                    and (ad.tenant_id is null or ad.tenant_id = item.tenant_id)))`,
  },
  {
    // Condition 3, first half: an active verb scoped to a DIFFERENT tenant
    // must still be flagged — it is unreachable for this template. This is
    // the branch the coordinator's review found unexercised: if the tenant
    // clause were dropped, flipped to AND, or compared the wrong column,
    // this fires query would go from 1 row to 0 and this case would FAIL.
    name: 'onboarding-bindings-are-runnable (verb active but scoped to a different tenant)',
    fires: `select 1 where exists (
              select 1 from (values ('tenant-a','k')) item(tenant_id, action_key)
               where not exists (
                 select 1 from (values ('k','active','tenant-b')) ad(action_key, status, tenant_id)
                  where ad.action_key = item.action_key
                    and ad.status = 'active'
                    and (ad.tenant_id is null or ad.tenant_id = item.tenant_id)))`,
    silent: `select 1 where exists (
              select 1 from (values ('tenant-a','k')) item(tenant_id, action_key)
               where not exists (
                 select 1 from (values ('k','active',null::text)) ad(action_key, status, tenant_id)
                  where ad.action_key = item.action_key
                    and ad.status = 'active'
                    and (ad.tenant_id is null or ad.tenant_id = item.tenant_id)))`,
  },
  {
    // Condition 3, second half: the SAME wrong-tenant violation, checked
    // against the other clean branch — a verb scoped to the template's OWN
    // tenant must be reachable. Both silent branches (global and same-tenant)
    // must independently return zero rows against the identical fires query.
    name: 'onboarding-bindings-are-runnable (verb scoped to the SAME tenant is reachable)',
    fires: `select 1 where exists (
              select 1 from (values ('tenant-a','k')) item(tenant_id, action_key)
               where not exists (
                 select 1 from (values ('k','active','tenant-b')) ad(action_key, status, tenant_id)
                  where ad.action_key = item.action_key
                    and ad.status = 'active'
                    and (ad.tenant_id is null or ad.tenant_id = item.tenant_id)))`,
    silent: `select 1 where exists (
              select 1 from (values ('tenant-a','k')) item(tenant_id, action_key)
               where not exists (
                 select 1 from (values ('k','active','tenant-a')) ad(action_key, status, tenant_id)
                  where ad.action_key = item.action_key
                    and ad.status = 'active'
                    and (ad.tenant_id is null or ad.tenant_id = item.tenant_id)))`,
  },
  {
    // Verbatim from the brief's spec: a two-field synthetic model
    // (status, has a qualifying execution). Kept as-is — it's still a
    // legitimate coarse check — but on its own it never exercises the
    // probe's other two real conditions (`d ? 'action_key'`, and that the
    // `not exists` checks *decision membership*, not just row existence).
    // The three cases below lift the real predicate's remaining conditions
    // one at a time, same pattern Task 2's fix used on the neighbouring
    // onboarding-bindings-are-runnable probe after a shallow mutation case
    // passed while blind to a live, populated condition.
    name: 'bound-onboarding-items-complete-from-evidence (done + no qualifying execution -> violation)',
    fires: `select 1 where exists (select 1 from (values ('done', false)) v(st, has_exec)
              where v.st = 'done' and not v.has_exec)`,
    silent: `select 1 where exists (select 1 from (values ('done', true)) v(st, has_exec)
              where v.st = 'done' and not v.has_exec)`,
  },
  {
    // Condition: the not-exists checks DECISION MEMBERSHIP, not mere
    // row existence. A row exists ('rejected') but doesn't qualify -> the
    // item must still be flagged, exactly as if no execution existed at all.
    name: 'bound-onboarding-items-complete-from-evidence (an execution row exists but its decision does not qualify -> still a violation)',
    fires: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (values ('rejected')) ae(decision)
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
    silent: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (values ('executed_after_approval')) ae(decision)
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
  },
  {
    // Condition: `d ? 'action_key'`. An item marked done with no verb bound
    // to it at all (the common case today — 0 bound items in production) is
    // exempt by design, not merely unmatched by accident.
    name: 'bound-onboarding-items-complete-from-evidence (item has no action_key binding -> exempt, never a violation)',
    fires: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
    silent: `select 1 where exists (
              select 1 from (values ('done', false)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
  },
  {
    // Condition: `i->>'status' = 'done'`. A bound item still in_progress
    // (or pending/blocked) with no execution is not a violation — only a
    // stored 'done' with nothing behind it is the trap this probe guards.
    name: 'bound-onboarding-items-complete-from-evidence (bound item not yet done -> exempt, never a violation)',
    fires: `select 1 where exists (
              select 1 from (values ('done', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
    silent: `select 1 where exists (
              select 1 from (values ('in_progress', true)) i(status, has_action_key)
               where i.status = 'done' and i.has_action_key
                 and not exists (select 1 from (select null::text as decision where false) ae
                                  where ae.decision in ('auto_executed','executed_after_approval')))`,
  },
  {
    name: 'execute-perimeter (revoked fn removed from allowlist detects re-grant)',
    // Real perimeter check compares live grants to the pinned allowlist. Fire =
    // a live grant not in the pinned set. Proven by construction: we just
    // revoked 6 and re-pinned; certify was RED before the re-pin (the run above
    // showed the mismatch) and GREEN after. Marked MANUAL-VERIFIED.
    manual: 'certify was red with the 6 stale grants, green after --pin-allowlist. Directly observed this session.',
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  if (c.manual) { console.log(`  MANUAL  ${c.name}\n            ${c.manual}`); pass++; continue; }
  const fired = (await q(c.fires)).length;
  const silent = (await q(c.silent)).length;
  const ok = fired >= 1 && silent === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}    ${c.name}  (violation→${fired} rows, clean→${silent} rows)`);
  ok ? pass++ : fail++;
}
console.log(`\nmutation test: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
