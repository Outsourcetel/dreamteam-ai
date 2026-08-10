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
import { productionEvidenceSql, PRODUCTION_EVIDENCE_PIN_NAMES } from './production-evidence.mjs';
import { bareContainerLiteralSql } from './bare-container-literal.mjs';

// ── Fixtures for no-untyped-literal-appended-to-a-container ────────────────
// The production catalog is CLEAN of this shape, so the probe returns zero rows
// and passes trivially. These fixtures are the only thing proving it can fire.
// They are fed through bareContainerLiteralSql() — the REAL query the probe
// runs — so a regex that matches nothing fails these cases instead of hiding
// behind a clean database. That is not hypothetical: the jsonb branch was first
// written with `\b` (a BACKSPACE in Postgres regex, not a word boundary), had
// zero coverage, and returned zero rows exactly like a clean scan.
const fx = (prosrc, fullargs = '') => [{ proname: 'fixture_fn', prosrc, fullargs }];

const BODY_BARE = fx(`declare v_errors text[] := '{}';
begin
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'; end if;
  return v_errors;
end;`);
const BODY_CAST = fx(`declare v_errors text[] := '{}';
begin
  if v_n < 1 then v_errors := v_errors || 'template needs at least 1 item'::text; end if;
  return v_errors;
end;`);
const BODY_FORMAT = fx(`declare v_errors text[] := '{}';
begin
  v_errors := v_errors || format('item "%s" needs a label', v_key);
  return v_errors;
end;`);
const BODY_ARRAY_APPEND = fx(`declare v_reasons text[] := '{}';
begin
  v_reasons := array_append(v_reasons, 'failed_certification');
  return v_reasons;
end;`);
const BODY_LITERAL_LEFT = fx(`declare v_errors text[] := '{}';
begin
  v_errors := 'template needs at least 1 item' || v_errors;
  return v_errors;
end;`);
const BODY_LITERAL_LEFT_CAST = fx(`declare v_errors text[] := '{}';
begin
  v_errors := 'template needs at least 1 item'::text || v_errors;
  return v_errors;
end;`);
// No '[' anywhere in these two, so the ARRAY branch of the regex cannot match
// them. Detection therefore depends entirely on the json branch and its \y.
const BODY_JSONB_BARE = fx(`declare v_doc jsonb := jsonb_build_array();
begin
  v_doc := v_doc || 'not valid json';
  return v_doc;
end;`);
const BODY_JSONB_CAST = fx(`declare v_doc jsonb := jsonb_build_array();
begin
  v_doc := v_doc || '{"ok": true}'::jsonb;
  return v_doc;
end;`);
const BODY_MULTILINE = fx(`declare v_errors text[] := '{}';
begin
  v_errors := v_errors
              ||
              'append spanning three lines';
  return v_errors;
end;`);
const BODY_MULTILINE_CAST = fx(`declare v_errors text[] := '{}';
begin
  v_errors := v_errors
              ||
              'append spanning three lines'::text;
  return v_errors;
end;`);
const BODY_ARRAY_CAT = fx(`declare v_errors text[] := '{}';
begin
  v_errors := array_cat(v_errors, 'malformed');
  return v_errors;
end;`);
const BODY_ARRAY_CAT_OK = fx(`declare v_errors text[] := '{}';
begin
  v_errors := array_cat(v_errors, array['fine']);
  return v_errors;
end;`);
const BODY_SCALAR = fx(`declare v_summary text := '';
begin
  v_summary := v_summary || 'Log activity on ' || v_acct_name;
  return v_summary;
end;`);
const BODY_COMMENTED = fx(`declare v_errors text[] := '{}';
begin
  -- v_errors := v_errors || 'this line is PROSE, exactly as mig 685 quotes it';
  v_errors := v_errors || format('item "%s" needs a label', v_key);
  return v_errors;
end;`);
const BODY_ARG_ARRAY = fx(`begin
  p_notes := p_notes || 'appended to an array argument';
  return p_notes;
end;`, 'p_notes text[]');
const BODY_ARG_ARRAY_CAST = fx(`begin
  p_notes := p_notes || 'appended to an array argument'::text;
  return p_notes;
end;`, 'p_notes text[]');
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
  // ── mig 682's ratchet: exam-evidence-stays-out-of-production-metrics ────
  // Same construction as 679's: the REAL probe over the LIVE catalog, one pin
  // removed / one bogus pin added. record_billable_outcome definitely reads
  // billable_outcomes and (post-682) never calls the predicate — dropping its
  // pin must make the real query name it.
  {
    name: 'exam-evidence-stays-out-of-production-metrics (drop a real pin -> the real probe names that function)',
    fires: productionEvidenceSql(PRODUCTION_EVIDENCE_PIN_NAMES.filter((n) => n !== 'record_billable_outcome')),
    silent: productionEvidenceSql(),
  },
  {
    name: 'exam-evidence-stays-out-of-production-metrics (a pin guarding nothing is itself a violation)',
    fires: productionEvidenceSql([...PRODUCTION_EVIDENCE_PIN_NAMES, 'zz_pin_for_a_body_that_does_not_exist']),
    silent: productionEvidenceSql(),
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
  // ── onboarding-bindings-are-runnable (rewritten for mig 681) ────────────
  // The probe used to check three conditions — action_key match, status
  // active, and tenant VISIBILITY — and the four cases here modelled exactly
  // those three. All four passed, and the probe was still wrong: platform
  // actions carry tenant_id IS NULL, so "visible" was true for every tenant
  // in the system. The cases could not have caught that, because they
  // faithfully modelled a predicate that was itself too weak. A mutation case
  // proves a probe fires on the violation it models; it cannot tell you the
  // model is missing a condition.
  //
  // mig 681 tightened the probe to what get_agentic_tools_for_de means by
  // runnable: a CONNECTED connector of that tenant, matching category AND
  // provider, with provider='internal' excluded. The cases below exercise
  // every clause of that predicate one at a time.
  {
    // FIRST, and most valuable: the LIVE tables, and the exact row that
    // separates the old probe from the new one. Workspace 5bb802e1 has one
    // connected connector, erpnext/erp_financials.
    //   · log_invoice_note is active and platform-scope, so it was VISIBLE and
    //     the old predicate stayed silent on it — but in erp_financials it
    //     exists only under provider 'xero'. Nothing that workspace owns can
    //     run it. The new predicate fires.
    //   · configure_customer_setup is the erpnext one. It must stay silent, or
    //     the tightening has simply broken binding for everyone.
    // Synthetic cases can only prove the predicate does what it says; this one
    // proves it says the right thing about real production data.
    name: 'onboarding-bindings-are-runnable (LIVE: a visible-but-unrunnable verb fires, the runnable one stays silent)',
    fires: `select 1 where exists (
              select 1 from (values ('5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,'log_invoice_note')) item(tenant_id, action_key)
               where not exists (
                 select 1 from action_definitions ad
                 join connectors c
                   on c.tenant_id = item.tenant_id and c.status = 'connected'
                  and c.category = ad.category
                  and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
                where ad.action_key = item.action_key and ad.status = 'active'
                  and ad.provider <> 'internal'
                  and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = item.tenant_id))))`,
    silent: `select 1 where exists (
              select 1 from (values ('5bb802e1-8e92-4eef-9a7a-ac348785d43f'::uuid,'configure_customer_setup')) item(tenant_id, action_key)
               where not exists (
                 select 1 from action_definitions ad
                 join connectors c
                   on c.tenant_id = item.tenant_id and c.status = 'connected'
                  and c.category = ad.category
                  and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
                where ad.action_key = item.action_key and ad.status = 'active'
                  and ad.provider <> 'internal'
                  and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = item.tenant_id))))`,
  },
  // The remaining cases lift the probe's real predicate over synthesised
  // item / action_definition / connector rows — no live table read, so they
  // hold whatever those tables come to contain. The predicate is written ONCE,
  // as a builder, rather than pasted per case: eight hand-copied predicates
  // are eight chances for a case to drift from the thing it claims to test,
  // which is exactly how mig 661 shipped a pin that could not fail.
  ...(() => {
    const lit = (v) => (v === null ? 'null::text' : `'${v}'`);
    const runnable = (o = {}) => {
      const d = {
        itemTenant: 'tenant-a', itemKey: 'k',
        adKey: 'k', adStatus: 'active', adScope: 'platform', adTenant: null,
        adCategory: 'crm', adProvider: 'hubspot',
        connTenant: 'tenant-a', connStatus: 'connected',
        connCategory: 'crm', connProvider: 'hubspot', ...o,
      };
      return `select 1 where exists (
        select 1 from (values ('${d.itemTenant}','${d.itemKey}')) item(tenant_id, action_key)
         where not exists (
           select 1
             from (values (${lit(d.adKey)},${lit(d.adStatus)},${lit(d.adScope)},${lit(d.adTenant)},${lit(d.adCategory)},${lit(d.adProvider)}))
                    ad(action_key, status, scope, tenant_id, category, provider)
             join (values (${lit(d.connTenant)},${lit(d.connStatus)},${lit(d.connCategory)},${lit(d.connProvider)}))
                    c(tenant_id, status, category, provider)
               on c.tenant_id = item.tenant_id
              and c.status = 'connected'
              and c.category = ad.category
              and (ad.provider is null or ad.provider = c.provider or ad.provider = 'template')
            where ad.action_key = item.action_key
              and ad.status = 'active'
              and ad.provider <> 'internal'
              and (ad.scope = 'platform' or (ad.scope = 'tenant' and ad.tenant_id = item.tenant_id))))`;
    };
    // Every case's `silent` is the all-clean row, so each `fires` differs from
    // it in exactly ONE field. That is what makes each case a test of one
    // clause rather than of the predicate in general.
    const clean = runnable();
    const case_ = (name, mutation) => ({ name: `onboarding-bindings-are-runnable (${name})`, fires: runnable(mutation), silent: clean });
    return [
      // ── the action_definitions side ──
      case_('named verb does not exist at all', { adKey: 'something-else' }),
      case_('named verb exists but is not active', { adStatus: 'draft' }),
      case_('verb is tenant-scoped to a DIFFERENT tenant', { adScope: 'tenant', adTenant: 'tenant-b' }),
      // ...and its clean twin: tenant-scoped to the template's OWN tenant is
      // fine. Without this, flipping the scope clause to a constant true would
      // pass every case above.
      { name: 'onboarding-bindings-are-runnable (verb tenant-scoped to the SAME tenant is runnable)',
        fires: runnable({ adScope: 'tenant', adTenant: 'tenant-b' }),
        silent: runnable({ adScope: 'tenant', adTenant: 'tenant-a' }) },
      // provider='internal' isolated: the connector's provider is 'internal'
      // too, so the provider-MATCH clause passes and the ONLY thing excluding
      // this row is `ad.provider <> 'internal'`. Engine primitives
      // (generate_invoice, start_onboarding) have their own step types and are
      // never reachable through a connector.
      case_('verb is an internal engine primitive, not a connector action',
            { adProvider: 'internal', connProvider: 'internal' }),
      // A NULL action provider is excluded too, because `null <> 'internal'`
      // is NULL, not true. That is a quirk of get_agentic_tools_for_de's own
      // SQL, copied deliberately so the validator, the probe and VerbBinding
      // agree; 0 of 75 definitions have a null provider, so it changes nothing
      // today. If someone ever fixes the quirk, they must fix all three, and
      // this case going red is how they find out.
      case_('verb with a NULL provider is excluded, as get_agentic_tools_for_de excludes it',
            { adProvider: null }),
      // ── the connectors side: the four clauses mig 681 added ──
      case_('the matching connector belongs to a DIFFERENT tenant', { connTenant: 'tenant-b' }),
      case_('the matching connector is DISCONNECTED', { connStatus: 'disconnected' }),
      case_('the workspace has a connector, but in another CATEGORY', { connCategory: 'helpdesk' }),
      case_('the workspace has a connector in the right category but a DIFFERENT provider',
            { connProvider: 'salesforce' }),
      // ...and the two ways a provider legitimately matches without being
      // equal, which a "provider must be equal" over-tightening would break.
      { name: 'onboarding-bindings-are-runnable (a template-provider verb runs against any connector in its category)',
        fires: runnable({ adProvider: 'stripe', connProvider: 'salesforce' }),
        silent: runnable({ adProvider: 'template', connProvider: 'salesforce' }) },
    ];
  })(),
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
  // ── mig 685's ratchet: no-untyped-literal-appended-to-a-container ───────
  // Every case runs bareContainerLiteralSql() — certify's ACTUAL query — over
  // a synthesised body. `silent` is never an empty fixture; it is always the
  // CORRECT way to write the same line, so these prove the probe discriminates
  // rather than merely fires.
  {
    name: 'untyped-literal-append (the exact mig 685 shape -> caught; ::text -> clean)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_CAST),
  },
  {
    name: 'untyped-literal-append (format(...) returns typed text and is NEVER a violation)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_FORMAT),
  },
  {
    // array_append is (anyarray, anyelement) — CORRECT code, and 19 real call
    // sites in public depend on it (assess_de_skills_internal, de_records_gate,
    // get_de_economics, set_doc_scope, set_pipeline_stages,
    // work_de_development_program_internal). A careless pattern flags all 19,
    // the probe gets switched off, and the class comes back.
    name: 'untyped-literal-append (array_append(arr, \'lit\') is CORRECT — 19 real call sites must stay clean)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_ARRAY_APPEND),
  },
  {
    name: 'untyped-literal-append (literal on the LEFT of || is the same defect)',
    fires: bareContainerLiteralSql(BODY_LITERAL_LEFT),
    silent: bareContainerLiteralSql(BODY_LITERAL_LEFT_CAST),
  },
  {
    // ⚠ THIS CASE GUARDS THE \y ESCAPE. Neither fixture contains a '[', so the
    // ARRAY branch of the regex cannot match them and detection depends
    // entirely on the json branch's word boundary. Rewrite `jsonb?\y` as
    // `jsonb?\b` in bare-container-literal.mjs and this case goes RED —
    // which is exactly what did NOT happen the first time, because there was
    // no such case and zero coverage looks identical to a clean database.
    name: 'untyped-literal-append (jsonb carries the same trap — GUARDS THE \\y WORD-BOUNDARY ESCAPE)',
    fires: bareContainerLiteralSql(BODY_JSONB_BARE),
    silent: bareContainerLiteralSql(BODY_JSONB_CAST),
  },
  {
    // The probe splits on ';' rather than newline. A line-based sieve returns
    // zero here, which is why the first draft of the sweep missed this shape.
    name: 'untyped-literal-append (an append split across THREE LINES is still caught)',
    fires: bareContainerLiteralSql(BODY_MULTILINE),
    silent: bareContainerLiteralSql(BODY_MULTILINE_CAST),
  },
  {
    // array_cat IS (anyarray, anyarray) — proven on production: it raised
    // 22P02 "malformed array literal" on a bare literal. Matching only when
    // the SECOND argument starts with a quote is what keeps array_cat(v,
    // array['fine']) out of the results.
    name: 'untyped-literal-append (array_cat with a literal is caught; array_cat(v, array[..]) is not)',
    fires: bareContainerLiteralSql(BODY_ARRAY_CAT),
    silent: bareContainerLiteralSql(BODY_ARRAY_CAT_OK),
  },
  {
    // 37 real statements in public concatenate a literal onto a SCALAR text
    // variable. That is ordinary string concatenation and always correct.
    name: 'untyped-literal-append (a SCALAR text variable is ordinary concatenation, never a violation)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_SCALAR),
  },
  {
    // mig 685's own header quotes the bugged line as prose. A probe that read
    // comments would manufacture a finding out of the documentation of the fix.
    name: 'untyped-literal-append (a COMMENTED-OUT example is prose, not a finding)',
    fires: bareContainerLiteralSql(BODY_BARE),
    silent: bareContainerLiteralSql(BODY_COMMENTED),
  },
  {
    name: 'untyped-literal-append (an array ARGUMENT is covered, not just a local)',
    fires: bareContainerLiteralSql(BODY_ARG_ARRAY),
    silent: bareContainerLiteralSql(BODY_ARG_ARRAY_CAST),
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
