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
import { productionEvidenceSql, PRODUCTION_EVIDENCE_PIN_NAMES, COUNT_READ_PIN_NAMES } from './production-evidence.mjs';
import { bareContainerLiteralSql } from './bare-container-literal.mjs';
import { unexecutableApprovalSql } from './unexecutable-approval.mjs';
import { advisoryBoundarySql } from './advisory-boundary.mjs';
import { trustProposerBoundarySql } from './trust-proposer-boundary.mjs';
import { gapGateConductSql, auditedStepsWritesSql, snapshotGateSql, gapEvidenceSql } from './playbook-gap-probes.mjs';
import { writePerimeterSql, silentNoopWriteSql } from './write-perimeter.mjs';

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Retry policy copied from certify.mjs, and for the same reason: a single
// transient 502 from the Management API used to throw out of q() and abort the
// WHOLE suite part-way, leaving a run that had proven some cases and not others
// while exiting nonzero — indistinguishable at a glance from a real mutation
// failure. TRANSPORT ONLY. A 4xx is where a genuine SQL error lands, and
// retrying one would be retrying a broken case into a timeout.
async function q(sql, attempt = 0) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const t = await res.text();
  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return q(sql, attempt + 1);
    }
    throw new Error(`${res.status}: ${t.slice(0,200)}`);
  }
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
  // ── Arms 7-9 (migs 707/709): count-reads carry the exam axis ─────────────
  // Same construction: the REAL probe over the LIVE catalog, one count-pin
  // removed / one bogus count-pin added. cluster_gap_candidates definitely
  // aggregates evidence_run_decisions with no exam axis — dropping its pin
  // must make the real query name it.
  {
    name: 'exam-evidence count-read arm (drop a real COUNT_READ pin -> the real probe names that function)',
    fires: productionEvidenceSql(PRODUCTION_EVIDENCE_PIN_NAMES, COUNT_READ_PIN_NAMES.filter((n) => n !== 'cluster_gap_candidates')),
    silent: productionEvidenceSql(),
  },
  {
    name: 'exam-evidence count-read arm (a COUNT_READ pin guarding nothing is itself a violation)',
    fires: productionEvidenceSql(PRODUCTION_EVIDENCE_PIN_NAMES, [...COUNT_READ_PIN_NAMES, 'zz_count_pin_for_nothing']),
    silent: productionEvidenceSql(),
  },
  {
    // THE ORGAN THAT SHIPPED THE DEFECT TWICE, pinned by its own history: the
    // `fires` body is the EXACT decision-read that was live in
    // assess_de_skills_internal until mig 707 (mig 430's text, verbatim); the
    // `silent` body is 707's replacement. If anyone re-creates the organ
    // without the filter — the third recreation the founder brief forbids —
    // this is the shape the live Arm 7 catches, proven here on the real
    // predicate rather than assumed.
    name: 'exam-evidence count-read arm (the exact pre-707 assess_de_skills_internal read is caught; the 707 read is clean)',
    fires: `select 1 where exists (select 1 from (values ('assess_de_skills_internal_v430',
              'select count(*), count(*) filter (where d.decision = ''needs_review'') from evidence_run_decisions d join evidence_runs er on er.id = d.evidence_run_id where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id and d.created_at > now() - interval ''30 days''')) v(nm, src)
             where src ilike '%evidence_run_decisions%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
    silent: `select 1 where exists (select 1 from (values ('assess_de_skills_internal_v707',
              'select count(*), count(*) filter (where d.decision = ''needs_review'') from evidence_run_decisions d join evidence_runs er on er.id = d.evidence_run_id where er.tenant_id = v_de.tenant_id and er.de_id = v_de.id and public.evidence_is_production(er.origin) and d.created_at > now() - interval ''30 days''')) v(nm, src)
             where src ilike '%evidence_run_decisions%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
  },
  {
    // The conversations half (arm 8), and the 571-shape channel literal as the
    // OTHER way to clear a body: a bare volume count fires; the same count
    // with `channel is distinct from 'exam'` is clean.
    name: 'exam-evidence count-read arm (a bare de_conversations volume count is caught; the channel literal clears it)',
    fires: `select 1 where exists (select 1 from (values ('a_new_digest',
              'select count(*) from de_conversations where tenant_id = v_t and last_message_at >= v_since')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
    silent: `select 1 where exists (select 1 from (values ('a_new_digest',
              'select count(*) from de_conversations where tenant_id = v_t and channel is distinct from ''exam'' and last_message_at >= v_since')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
  },
  {
    // ⚠ prosrc includes comments (the house rule). The UNQUOTED word "exam" in
    // a comment must NOT silence the sieve — only the quoted literal (an
    // actual channel filter) or the predicate call does. The known residual —
    // a comment containing the QUOTED literal would silence it — is documented
    // at COUNT_READ_PINS; this case pins the discrimination that exists.
    name: 'exam-evidence count-read arm (the unquoted word exam in a comment does NOT clear a body)',
    fires: `select 1 where exists (select 1 from (values ('a_commented_organ',
              '-- exams are not production work, someday we should filter them
               select count(*) from de_conversations where tenant_id = v_t')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
    silent: `select 1 where exists (select 1 from (values ('a_commented_organ',
              'select count(*) from de_conversations where tenant_id = v_t and channel is distinct from ''exam''')) v(nm, src)
             where src ilike '%from de_conversations%' and src ilike '%count(%'
               and src not ilike '%evidence_is_production%' and src not ilike '%''exam''%'
               and nm not in (${COUNT_READ_PIN_NAMES.map((n) => `'${n}'`).join(', ')}))`,
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
  // ── no-pending-approval-the-platform-cannot-carry-out ──────────────────
  // Every case runs certify's ACTUAL query — real connectors, real
  // action_definitions, real pg_proc — with ONE synthesised row UNIONed into
  // the population, and counts only the rows naming that fixture. No writes.
  // `silent` is never an empty population; it is always the SAME row made
  // executable, so these prove the probe discriminates rather than merely
  // fires. (The live, rolled-back-transaction version of these three — real
  // INSERTs into human_tasks/action_executions inside a transaction that
  // aborts — was run once against production when the probe shipped; all
  // three fired and named the right kind, action_executions stayed at 186.
  // These are the standing form of that proof.)
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';        // outsourcetel-hq
    const DEF = '00003ef9-96d6-416e-9b21-3ea7301e83e6';       // send_payment_reminder, erp_financials, active
    const ERP = '7f595bec-2f73-44d2-8f89-20961ad11e0e';       // erpnext / erp_financials
    const OTHER = '73ab12eb-ddf1-4d64-8cc3-e4c917c5b604';     // mcp / other — right tenant, WRONG category
    // A synthesised population row. Defaults are the CLEAN one: the connector
    // that carries this verb, the definition that was gated, matching category.
    const row = (o = {}) => {
      const d = { conn: `'${ERP}'::uuid`, def: `'${DEF}'::uuid`, key: 'send_payment_reminder', ...o };
      return `  select '00000000-0000-4000-8000-00000000dead'::uuid, '${HQ}'::uuid, ${d.conn}, ${d.def},
                      '${d.key}'::text, 'outsourcetel-hq'::text, 'MUTATION FIXTURE'::text`;
    };
    // Only rows naming the fixture count — production carries one real
    // violation of this class (kinetic / create_specialist, whose definition
    // was disabled by mig 611), and a case that counted it would pass without
    // the mutation.
    const only = (kind, extra) => `select 1 from (${unexecutableApprovalSql({ extra })}) x
       where x.violation like '${kind} — %' and x.violation like '%MUTATION FIXTURE%'`;
    const case_ = (kind, name, mutation) => ({
      name: `unexecutable-approval (${name})`,
      fires: only(kind, row(mutation)),
      silent: only(kind, row()),
    });
    return [
      // mig 701's defect, exactly: the sweep wrote a null routing column.
      case_('unroutable', 'connector_id NULL -> connector-hub refuses at the door', { conn: 'null::uuid' }),
      // The other way a row is unroutable: the connector is not this
      // workspace's (deleted, or another tenant's) -> connector_not_found.
      case_('unroutable', 'the named connector is not a connector of this workspace',
            { conn: `'00000000-0000-4000-8000-00000000c0de'::uuid` }),
      // The named executor is real and active but unreachable THROUGH THIS
      // CONNECTOR, because the resolver keys on the CONNECTOR's category.
      case_('mismatched-pair', 'the named executor is not in the connector\'s category',
            { conn: `'${OTHER}'::uuid` }),
      // The half of `ambiguous` that a row can carry. It cannot arise from an
      // INSERT today (action_executions.action_definition_id is NOT NULL) and
      // that is stated in the probe rather than pretended otherwise — this
      // case is what keeps the arm honest if the constraint ever goes.
      case_('ambiguous', 'two live executors and the row names neither', { def: 'null::uuid' }),
      // ...and the discrimination that matters most: an UNAMBIGUOUS pair with
      // no disambiguator is NOT a violation. Without this, an arm that fired
      // on every null would look identical to the correct one.
      { name: 'unexecutable-approval (a single-executor pair needs no disambiguator and is never flagged)',
        fires: only('ambiguous', row({ def: 'null::uuid' })),
        silent: only('ambiguous', row({ def: 'null::uuid', key: 'flag_for_collections' })) },
    ];
  })(),
  // ── The FOURTH kind: `no-executor` (mig 704's sibling) ─────────────────
  // Same construction as the three above, but through the OTHER population
  // hook: `orphanExtra` feeds the task scan, which deliberately does not join
  // action_executions. Whether a fixture is FLAGGED is still decided by the
  // real action_executions table, so `silent` uses a REAL pending approval's
  // task id — one that genuinely has an execution row — wearing the same
  // fixture title. Firing on one and not the other is therefore the probe
  // discriminating, not the harness choosing.
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';         // outsourcetel-hq
    // A real pending action_approval linked to a real action_executions row
    // via task_id (execution 7371abf7…). Deciding it later would not break
    // this case: a decision does not delete the execution row, and the fixture
    // supplies its own task row regardless of the real one's status.
    const LINKED = '87146a8e-9e2a-4ba1-ab93-93791efb2adb';
    const ORPHAN = '00000000-0000-4000-8000-00000000face';     // referenced by nothing
    const row = (taskId) => `  select '${taskId}'::uuid, '${HQ}'::uuid, 'outsourcetel-hq'::text,
                      'MUTATION FIXTURE'::text, '2026-08-11T00:00:00Z'::timestamptz`;
    // Production carries one REAL row of this kind (the founder's "test ping",
    // deliberately not allowlisted), so a case that counted every no-executor
    // row would pass without the mutation. Only the fixture counts.
    const only = (extra) => `select 1 from (${unexecutableApprovalSql({ orphanExtra: extra })}) x
       where x.violation like 'no-executor — %' and x.violation like '%MUTATION FIXTURE%'`;
    return [
      {
        name: 'unexecutable-approval (no-executor: a pending approval with NOTHING behind it is flagged)',
        fires: only(row(ORPHAN)),
        silent: only(row(LINKED)),
      },
    ];
  })(),
  {
    name: 'unexecutable-approval (no-executor: BOTH linkage columns clear a task, not just task_id)',
    manual: 'Driven against DEV inside a transaction that ABORTS, over the REAL probe query and REAL rows '
      + '(a values fixture cannot express this — the NOT EXISTS reads the live action_executions table). '
      + 'A pending action_approval with no execution row: arm named it (1 row). An execution row added '
      + 'linking ONLY by resolves_task_id (mig 642 linkage, task_id left null): arm went SILENT (0 rows). '
      + 'That link deleted again: arm named it once more (1 row). So an arm written with task_id alone '
      + 'would manufacture a finding on a healthy row. Rolled back. Directly observed 2026-08-11.',
  },
  {
    // THE DENOMINATOR ARM. mig 701 back-filled the two known-bad rows hours
    // before this probe was written, so its three arms find nothing today —
    // and zero findings from zero comparisons is indistinguishable from a
    // clean result. This is the case proving the probe refuses to call an
    // empty population a pass.
    name: 'unexecutable-approval (an empty population is a VIOLATION, not a pass)',
    fires: `select 1 from (${unexecutableApprovalSql({ empty: true })}) x
             where x.violation like 'no-comparisons — %'`,
    silent: `select 1 from (${unexecutableApprovalSql()}) x
             where x.violation like 'no-comparisons — %'`,
  },
  {
    // ...and the SECOND denominator, separately. The two populations are
    // different queries — one joins through action_executions, one refuses to
    // — so one going to zero must not be masked by the other being healthy.
    // Without this case, the task scan could silently read nothing and the
    // no-executor arm would look clean from having examined no rows.
    name: 'unexecutable-approval (an empty TASK SCAN is its own violation, not masked by a healthy population)',
    fires: `select 1 from (${unexecutableApprovalSql({ emptyTasks: true })}) x
             where x.violation like 'no-comparisons — %'`,
    silent: `select 1 from (${unexecutableApprovalSql()}) x
             where x.violation like 'no-comparisons — %'`,
  },
  {
    // The `ambiguous` arm's OTHER half — mig 703's defect — reads the driver's
    // selector out of pg_proc, which a SELECT cannot fake. What CAN be tested
    // as a SELECT is the pattern itself, and it is worth testing: mig 703
    // recorded that a bare `ae\.action_definition_id` match SURVIVED the
    // null::uuid mutant, because the JOIN condition further down the body
    // satisfies it. The anchor to the select list is the fix, and this is what
    // stops someone "simplifying" it back.
    name: 'unexecutable-approval (the selector pattern is anchored to the SELECT LIST, not the bare token)',
    fires: `select 1 where not (
              'select t.id, t.slug, ht.id, ae.id, ae.connector_id, null::uuid, ad.action_key
                 from action_executions ae join action_definitions ad on ad.id = ae.action_definition_id'
              ~ 'ae\\.connector_id,\\s*ae\\.action_definition_id')`,
    silent: `select 1 where not (
              'select t.id, t.slug, ht.id, ae.id, ae.connector_id, ae.action_definition_id, ad.action_key
                 from action_executions ae join action_definitions ad on ad.id = ae.action_definition_id'
              ~ 'ae\\.connector_id,\\s*ae\\.action_definition_id')`,
  },
  {
    name: 'unexecutable-approval (the bare-token pattern mig 703 rejected would NOT have caught the mutant)',
    // Same two bodies, the LOOSE pattern. It must stay silent on BOTH — which
    // is what makes the anchored one load-bearing rather than decorative.
    fires: `select 1 where not (
              'select ae.connector_id, null::uuid from action_executions ae'
              ~ 'ae\\.action_definition_id')`,
    silent: `select 1 where not (
              'select ae.connector_id, null::uuid from action_executions ae
                 join action_definitions ad on ad.id = ae.action_definition_id'
              ~ 'ae\\.action_definition_id')`,
  },
  {
    name: 'unexecutable-approval (LIVE DDL mutant: due_approved_actions stops forwarding the executor)',
    manual: 'mig 703 recreated inside a transaction that ABORTS, with null::uuid in the select list and the '
      + 'return type unchanged: the probe named 4 real production rows as `ambiguous` (outsourcetel-hq '
      + 'send_payment_reminder, two live ERPNext executors — an internal note and an email to the customer). '
      + 'Rolled back; the live selector was re-read afterwards and is intact. Directly observed 2026-08-11.',
  },
  {
    name: 'mig 704 retirement guard (19 live DDL mutants against its own assert block)',
    manual: 'The guard that alerts when an action_definition leaves status=active while a PENDING approval '
      + 'still names it. Its assert block was extracted from the shipped migration file (not paraphrased) and '
      + 'run against DEV after each mutation, in transactions that ABORT. Baseline green first, or every '
      + 'catch below would be meaningless. 19 mutants, 19 CAUGHT, 0 survived, 0 inconclusive — each scored '
      + 'only because the error NAMED the injected defect. Structural: WHEN clause removed (fires on every '
      + 'definition update), BEFORE instead of AFTER (can veto a retirement), writes to human_tasks, calls '
      + 'decide_human_task, never inserts an alert, tenant dropped from the dedup kind, definition dropped '
      + 'from it, only task_id checked (misses mig 642 resolves_task_id links), pending filter widened, '
      + 'anon/authenticated/PUBLIC granted EXECUTE, SECURITY DEFINER removed. ⚠ The PUBLIC case needed its '
      + 'own construction: a grant to PUBLIC also gives anon EXECUTE, so the anon pin fired first and the '
      + 'run did not name PUBLIC — INCONCLUSIVE under the strict rule, not a catch. Re-run with the anon and '
      + 'authenticated pins removed so only the PUBLIC pin could speak (plus a control proving that removal '
      + 'alone keeps the block green). BEHAVIOURAL, all passing the source pins and caught only because the '
      + 'assert block DRIVES the trigger: alerts on every retirement (F1), never alerts on a real stranding '
      + '(F3), alert stops naming the task (F3), and a decision made through dynamic SQL the prosrc pin '
      + 'cannot see (F4). One further mutant — the same dynamic decision WITHOUT the sanction GUC — is '
      + 'stopped by guard_human_task_decision rather than by mig 704, and is recorded as that rather than '
      + 'claimed as this migration\'s catch. Directly observed 2026-08-11.',
  },
  // ── mig 705's boundary: advisory-layer-cannot-decide ────────────────────
  // The coverage arms run certify's ACTUAL query with a fixture row UNIONed
  // into the task scan (no writes). Whether a fixture is FLAGGED is decided by
  // the real approval_briefs table: an orphan uuid has no brief and fires; a
  // REAL pending approval's task id (briefed by the mig-705 backfill, and its
  // brief row survives the task being decided — only task DELETION cascades)
  // stays silent. Firing on one and not the other is the probe discriminating.
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';        // outsourcetel-hq
    // A real action_approval on prod, briefed by the 705 backfill: the
    // outsourcetel-hq "Grant Plastics" follow-up of 2026-08-05. Deciding it
    // later cannot break this case — the brief row survives a decision (only
    // task DELETION cascades), and the fixture supplies its own task row.
    const BRIEFED = '87146a8e-9e2a-4ba1-ab93-93791efb2adb';
    const ORPHAN = '00000000-0000-4000-8000-0000000005b1';    // referenced by nothing
    const row = (taskId) => `  select '${taskId}'::uuid, '${HQ}'::uuid,
                      'outsourcetel-hq'::text, 'MUTATION FIXTURE'::text`;
    const only = (extra) => `select 1 from (${advisoryBoundarySql({ orphanExtra: extra })}) x
       where x.violation like 'missing-brief — %' and x.violation like '%MUTATION FIXTURE%'`;
    return [
      {
        name: 'advisory-boundary (missing-brief: a pending approval with no brief row is flagged)',
        fires: only(row(ORPHAN)),
        silent: only(row(BRIEFED)),
      },
      {
        name: 'advisory-boundary (an empty task scan is a VIOLATION, not a pass)',
        fires: `select 1 from (${advisoryBoundarySql({ emptyTasks: true })}) x
                 where x.violation like 'no-comparisons — %'`,
        silent: `select 1 from (${advisoryBoundarySql()}) x
                 where x.violation like 'no-comparisons — %'`,
      },
      {
        // The identity-drift arm's LEFT JOIN mechanics, isolated: an expected
        // signature with no live counterpart must fire, a matched one must not.
        name: 'advisory-boundary (identity-drift: a vanished writer function is itself a violation)',
        fires: `select 1 from (values ('list_approval_briefs()')) exp(sig)
                 left join (select null::text as sig where false) live on live.sig = exp.sig
                where live.sig is null`,
        silent: `select 1 from (values ('list_approval_briefs()')) exp(sig)
                 left join (values ('list_approval_briefs()')) live(sig) on live.sig = exp.sig
                where live.sig is null`,
      },
    ];
  })(),
  {
    name: 'advisory-boundary (9 live mutants against the REAL probe on dev)',
    manual: 'Driven against DEV (mig 705 applied) on 2026-08-12, each mutant inside a DO block ending in '
      + 'RAISE EXCEPTION so the injected break rolls back; the exception message carried the probe rows, '
      + 'so every catch is scored on the probe NAMING the break. 9 mutants, 9 CAUGHT, 0 survived, '
      + '0 inconclusive: GRANT EXECUTE on decide_human_task to the role (can-decide); GRANT UPDATE on '
      + 'human_tasks (can-write-queue); list_approval_briefs owner flipped to postgres (identity-drift); '
      + 'compute_approval_brief made VOLATILE (identity-drift); refresh writer stripped of SECURITY DEFINER '
      + '(identity-drift); list_approval_briefs rewritten to serve stored rows without recomputing '
      + '(identity-drift, the stored-marker trap); role granted EXECUTE on decide_de_escalation '
      + '(reachable-decider — the two-paths trap); a pending approval whose brief row was deleted '
      + '(missing-brief, with its in-transaction control: arm silent while the trigger-written brief '
      + 'existed); the role dropped outright with DROP OWNED (role-gone). The last one first came back '
      + 'INCONCLUSIVE twice and forced two real fixes: DROP OWNED needed the trigger dropped first, and '
      + 'has_function_privilege(\'name\',…) RAISES 42704 on a missing role — the probe now resolves the '
      + 'role through a pg_roles OID join so role-gone reports instead of erroring. Dev verified fully '
      + 'rolled back afterwards (role/trigger/volatility/privileges intact, 0 leftover fixtures).',
  },
  // ── mig 710's boundary: trust-proposer-cannot-decide ─────────────────────
  // The evidence arms run certify's ACTUAL query with a fixture proposal
  // UNIONed into the scan (no writes). Whether a fixture FIRES is decided by
  // the real LEDGER: a citation naming three genuinely approved, landed,
  // production decisions stays silent; a citation the ledger cannot confirm
  // fires. Firing on one and not the other is the probe discriminating.
  {
    name: 'trust-proposer (16 live DDL mutants against the REAL probe on dev)',
    manual: 'Driven against DEV (mig 710 applied) on 2026-08-12, each mutant inside a DO block ending in '
      + 'RAISE EXCEPTION so the injected break rolls back; the exception message carried the probe rows, so '
      + 'every catch is scored on the probe NAMING the break. 16 mutants, 16 CAUGHT, 0 survived, 0 '
      + 'inconclusive, plus a no-mutation CONTROL proving zero violations on clean dev: GRANT EXECUTE on '
      + 'decide_human_task / apply_trust_promotion / set_de_autonomy to the role (can-decide ×3); GRANT '
      + 'UPDATE on human_tasks, GRANT UPDATE (current_level) on trust_policies, GRANT INSERT on de_autonomy, '
      + 'GRANT UPDATE on approval_authority (can-write ×4); REVOKE INSERT on human_tasks and REVOKE UPDATE '
      + '(pending_task_id) (cannot-file ×2, the built-but-unfed liveness half); writer owner flipped to '
      + 'postgres, detector made VOLATILE, detector body stubbed losing its conjunct predicates '
      + '(identity-drift ×3); role granted EXECUTE on set_trust_ladder, whose body reaches the dial '
      + '(reachable-decider — the two-paths trap); writer granted to authenticated (seam-reachable); '
      + 'de_governance_sweep_internal stubbed without the proposer call (sweep-unfed); DROP OWNED + DROP '
      + 'ROLE (role-gone). Dev verified fully rolled back afterwards (owner/volatility/conjuncts/grants '
      + 'intact, 0 leftover fixtures).',
  },
  {
    name: 'trust-proposer (13-group behavioral fixture matrix drives the REAL detector + writer on dev)',
    manual: 'Driven against DEV on 2026-08-12 inside one rolled-back transaction: thirteen fixture groups, '
      + 'each isolating ONE conjunct of the mig-710/711 pattern test — baseline (3 clean landed production '
      + 'approvals) FIRES; exam-origin decision does not count (682/707 axis); un-landed approval does not '
      + 'count (679 predicate); a rollback voids the pattern; destructive actions are excluded (the dial '
      + 'opens nothing above the destructive gate); a rejection voids the pattern; a DECLINED prior proposal '
      + 'blocks re-raise until the pattern re-accumulates; N=2 stays below the floor of 3; an open proposal '
      + 'blocks a second; a policy-ineligible group (trust_evidence_for says no) is refused; an identical '
      + 'qualifying group in a SUSPENDED workspace produces nothing; the mig-711 bimap shape (specific ladder '
      + 'approval-blind, generic action_execute+source ladder eligible) FIRES and maps to the generic — the '
      + 'ladder the evidence actually climbs; the same shape with an open proposal on the blind rung is '
      + 'blocked chain-wide. Detector returned EXACTLY the two firing groups and nothing else. Then the REAL '
      + 'writer ran under the role: raised=2, pending_task_id linkage set on both, citation carries exactly '
      + '3 decisions, mig-705 brief row present at birth, second run raised 0, suspended workspace raised 0. '
      + 'SCORECARD passes=19, failures NONE. The 710 run of this suite is what caught the '
      + 'silent zero-row UPDATE (RLS applies SELECT policies to the WHERE read of an UPDATE) that would have '
      + 'let every sweep re-raise the same proposal forever.',
  },
  ...(() => {
    const HQ = '5bb802e1-8e92-4eef-9a7a-ac348785d43f';       // outsourcetel-hq (active)
    const ACME = 'a1b2c3d4-0000-0000-0000-000000000001';     // acme-telecom (suspended)
    // Morgan's four real approved-and-landed send_payment_reminder decisions
    // (2026-08-04/05) — production origin, each with a landed execution.
    // Deciding or even voiding their TASKS later cannot break these cases:
    // the ledger arms re-check status='approved' + landed, both of which are
    // terminal states, and the fixture supplies its own proposal row.
    const REAL = ['c0701141-5d0c-4e7c-b2c6-1942f1462fb9',
                  '9d3f51b5-8956-41f8-b139-140b0c33843e',
                  'dfe869eb-27f2-41c6-b6ba-19000a10d858'];
    const BOGUS = '00000000-0000-4000-8000-000000000710';    // referenced by nothing
    const evidence = (ids) => `jsonb_build_object('pattern', jsonb_build_object('n_approved', ${ids.length}, 'decisions',
                      jsonb_build_array(${ids.map((id) => `jsonb_build_object('task_id', '${id}')`).join(', ')})))`;
    const prop = (tenant, ids) => `  select '00000000-0000-4000-8000-000000000711'::uuid, '${tenant}'::uuid,
                      'MUTATION FIXTURE'::text, ${evidence(ids)}`;
    const only = (arm, extra) => `select 1 from (${trustProposerBoundarySql({ proposalExtra: extra })}) x
       where x.violation like '${arm} — %' and x.violation like '%MUTATION FIXTURE%'`;
    return [
      {
        name: 'trust-proposer (citation-not-in-ledger: a cited decision the ledger cannot confirm is flagged; three real landed decisions are not)',
        fires: only('citation-not-in-ledger', prop(HQ, [REAL[0], REAL[1], BOGUS])),
        silent: only('citation-not-in-ledger', prop(HQ, REAL)),
      },
      {
        name: 'trust-proposer (citation-below-floor: fewer than 3 cited decisions is flagged)',
        fires: only('citation-below-floor', prop(HQ, [REAL[0], REAL[1]])),
        silent: only('citation-below-floor', prop(HQ, REAL)),
      },
      {
        name: 'trust-proposer (a suspended workspace holding an open system proposal is flagged; an active one is not)',
        fires: only('proposal-in-dormant-workspace', prop(ACME, REAL)),
        silent: only('proposal-in-dormant-workspace', prop(HQ, REAL)),
      },
      {
        // The orphan arm's mechanics: a pending proposal NO policy points at
        // fires; one with a live pending_task_id back-pointer does not. The
        // silent half rides on acme's stale-but-present linkage
        // (trust_policies.pending_task_id = 406f7bda…, the July answer_dock
        // request whose rejection never cleared the pointer) — stable unless
        // someone re-requests that policy, and the comment in the case name
        // will say so if it ever flips.
        name: 'trust-proposer (orphan-proposal: a pending proposal no policy points at is flagged)',
        fires: `select 1 from (${trustProposerBoundarySql({ orphanExtra:
          `  select '${BOGUS}'::uuid, 'MUTATION FIXTURE'::text, 'orphan fixture'::text` })}) x
           where x.violation like 'orphan-proposal — %' and x.violation like '%MUTATION FIXTURE%'`,
        silent: `select 1 from (${trustProposerBoundarySql({ orphanExtra:
          `  select '406f7bda-00c9-42b8-9c4c-23be8a10035b'::uuid, 'MUTATION FIXTURE'::text, 'linked fixture'::text` })}) x
           where x.violation like 'orphan-proposal — %' and x.violation like '%MUTATION FIXTURE%'`,
      },
    ];
  })(),
  {
    name: 'execute-perimeter (revoked fn removed from allowlist detects re-grant)',
    // Real perimeter check compares live grants to the pinned allowlist. Fire =
    // a live grant not in the pinned set. Proven by construction: we just
    // revoked 6 and re-pinned; certify was RED before the re-pin (the run above
    // showed the mismatch) and GREEN after. Marked MANUAL-VERIFIED.
    manual: 'certify was red with the 6 stale grants, green after --pin-allowlist. Directly observed this session.',
  },
  // ── mig 712 typed gaps: the four new probes, each driven through the REAL
  // SQL builders over synthesised rows. `fires` filters on the violation TEXT
  // naming the injected break (strict scoring); `silent` runs the same query
  // over the clean twin and must return zero VIOLATION rows (note/denominator
  // rows are excluded by the violation-is-not-null filter).
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const FXD = '00000000-0000-4000-8000-000000000712';   // fixture definition id
    const FXT = '00000000-0000-4000-8000-000000000042';   // fixture tenant id
    // a def row that never qualifies for the data arm (insert-stamped) — used
    // where a case needs the OTHER arm isolated, because an empty VALUES list
    // is a syntax error, not an empty fixture.
    const benignDef = { id: FXD, tenant_id: FXT, name: 'fx', key: 'fx', created_at: '2026-08-13T10:00:00Z', steps_updated_at: '2026-08-13T10:00:00Z' };
    const gapBase = { id: FXD, definition_id: FXD, kind: 'missing_knowledge', gap_key: 'knowledge:fx', source: 'study' };
    return [
      {
        name: 'gap-gate-can-only-pause (a gap_gate recorded done IS the forbidden execute-anyway; waiting/skipped stay silent)',
        fires: viol(gapGateConductSql([{ id: 'fx-run', steps: [{ key: 'gap_gate', status: 'done' }, { key: 'complete', status: 'pending' }] }]),
          `gap_gate step ended ''done''`),
        silent: viol(gapGateConductSql([{ id: 'fx-run', steps: [{ key: 'gap_gate', status: 'waiting' }, { key: 'gap_gate', status: 'skipped' }, { key: 'gap_gate', status: 'cancelled' }, { key: 'complete', status: 'pending' }] }])),
      },
      {
        name: 'playbook-steps-writes-are-audited (DRIVING ARM: the probe pointed at a trigger name that does not exist reports the guard missing)',
        fires: viol(auditedStepsWritesSql({ triggerName: 'zz_no_such_trigger_712', defs: [benignDef], events: [].concat([{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T10:00:00Z' }]) }),
          'MISSING or DISABLED'),
        silent: viol(auditedStepsWritesSql({ defs: [benignDef], events: [{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T10:00:00Z' }] })),
      },
      {
        name: 'playbook-steps-writes-are-audited (DATA ARM: a steps update with no audit event within 5 minutes fires; the same update with its event is silent)',
        fires: viol(auditedStepsWritesSql({
          defs: [{ id: FXD, tenant_id: FXT, name: 'fx', key: 'fx', created_at: '2026-08-13T10:00:00Z', steps_updated_at: '2026-08-13T11:00:00Z' }],
          events: [{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T18:00:00Z' }],
        }), 'NO playbook_steps_updated audit event'),
        silent: viol(auditedStepsWritesSql({
          defs: [{ id: FXD, tenant_id: FXT, name: 'fx', key: 'fx', created_at: '2026-08-13T10:00:00Z', steps_updated_at: '2026-08-13T11:00:00Z' }],
          events: [{ tenant_id: FXT, definition_id: FXD, kind: 'playbook_steps_updated', created_at: '2026-08-13T11:00:30Z' }],
        })),
      },
      {
        name: 'published-snapshots-respect-the-gate (a snapshot smuggling an unpinned primitive is named; the pinned vocabulary is silent)',
        fires: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'teleport_money' }, { key: 'complete' }] }]),
          'outside the pinned snapshot vocabulary'),
        silent: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'instruction' }, { key: 'gap_gate', params: { gap_id: FXD } }, { key: 'complete' }] }])),
      },
      {
        name: 'published-snapshots-respect-the-gate (last_step + double-approval relaxations land as named rows)',
        fires: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'generate_invoice' }, { key: 'human_approval' }, { key: 'human_approval' }, { key: 'instruction' }] }]),
          'not complete'),
        silent: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'generate_invoice' }, { key: 'human_approval' }, { key: 'complete' }] }])),
      },
      {
        name: 'published-snapshots-respect-the-gate (a gap_gate that cannot name its gap fires; pin-date scoping keeps the 14 legacy snapshots as reported debt, not findings)',
        fires: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'gap_gate', params: {} }, { key: 'complete' }] }]),
          'no gap_id'),
        // the SAME violating shape dated before the pin is scoped out — this is
        // the half that proves the date scope works and cannot silently widen
        silent: viol(snapshotGateSql([{ id: 'fx-v', published_at: '2026-07-01T00:00:00Z', steps: [{ key: 'gap_gate', params: {} }, { key: 'instruction' }] }])),
      },
      {
        // mig 713 DRIVING ARM. The 14 legacy rows are excluded by date, so a
        // clean post-pin corpus alone can NEVER fail this probe — a dropped
        // table gate would be invisible. Pointing the pin at a trigger name
        // that does not exist simulates exactly that drop.
        name: 'published-snapshots-respect-the-gate (DRIVING ARM, mig 713: the playbook_versions table gate dropped or disabled is named even with zero bad rows)',
        fires: viol(snapshotGateSql(
          [{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'instruction' }, { key: 'complete' }] }],
          { triggerName: 'zz_no_such_trigger_713' }), 'MISSING or DISABLED'),
        silent: viol(snapshotGateSql(
          [{ id: 'fx-v', published_at: '2026-08-13T00:00:00Z', steps: [{ key: 'instruction' }, { key: 'complete' }] }])),
      },
      {
        // mig 713 RATCHET ARM. A snapshot inserted with a BACKDATED
        // published_at is the one route past every post-pin arm; the
        // high-water mark is what notices it. Inverted by lifting the mark
        // over the same rows — the ratchet must go quiet, not the fixture.
        name: 'published-snapshots-respect-the-gate (RATCHET ARM, mig 713: pre-pin failing snapshots rising above the high-water mark fires; the same rows under a raised mark are silent)',
        fires: viol(snapshotGateSql([
          { id: 'fx-old-1', published_at: '2026-07-01T00:00:00Z', steps: [{ key: 'instruction' }] },
          { id: 'fx-old-2', published_at: '2026-07-02T00:00:00Z', steps: [{ key: 'instruction' }] },
        ], { legacyMax: 1 }), 'high-water mark'),
        silent: viol(snapshotGateSql([
          { id: 'fx-old-1', published_at: '2026-07-01T00:00:00Z', steps: [{ key: 'instruction' }] },
          { id: 'fx-old-2', published_at: '2026-07-02T00:00:00Z', steps: [{ key: 'instruction' }] },
        ], { legacyMax: 2 })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (a RESOLVED knowledge gap with no retrieved doc in its answer is a say-so closure and fires)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'resolved', answer: { note: 'trust me' }, answered_at: '2026-08-13T10:00:00Z', resolved_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        }), 'no doc evidence'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'resolved', answer: { doc_id: FXD }, answered_at: '2026-08-13T10:00:00Z', resolved_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (resolved-without-timestamp and answered-without-answer are stored markers and fire)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'resolved', answer: { doc_id: FXD }, answered_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        }), 'resolved_at is NULL'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'answered', answer: { doc_id: FXD }, answered_at: '2026-08-13T10:00:00Z' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 0 }],
        })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (COVERAGE: a study that raised gaps with zero rows behind it means objections are prose again)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, definition_id: '00000000-0000-4000-8000-00000000dead', status: 'open' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 3, n_validation_errors: 0 }],
        }), 'ZERO playbook_gaps rows'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'open' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 3, n_validation_errors: 0 }],
        })),
      },
      {
        name: 'playbook-gaps-hold-their-evidence (COVERAGE: validator errors recorded with no validator-sourced gaps = errors dropped again, spec §1.2b)',
        fires: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'open', source: 'study' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 2 }],
        }), 'dropped again'),
        silent: viol(gapEvidenceSql({
          gaps: [{ ...gapBase, status: 'open', source: 'validator' }],
          studies: [{ definition_id: FXD, updated_at: '2026-08-13T10:00:00Z', n_gaps: 1, n_validation_errors: 2 }],
        })),
      },
    ];
  })(),
  // ── migs 714/715/716-719: authenticated-write-perimeter ──────────────────
  // Arms 2 and 3 driven through the REAL builder over synthesised catalogue
  // rows. Every source is substitutable precisely so these cases exercise the
  // shipped predicate rather than a paraphrase — and each `fires` filters on
  // the violation TEXT naming the injected break, so a probe that returned
  // some OTHER row would score as a miss, not a catch.
  //
  // The point of the negative cases: arm 2's predicate has four conjuncts
  // (schema, grantee, privilege, base-table). A case that only flips TRUNCATE
  // to SELECT proves one of them. `service_role` and `storage` prove the other
  // two are not vacuous — a probe that fired on every grant in the database
  // would pass a single-conjunct test and be useless.
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const grant = (grantee, priv, sch = 'public', tbl = 'mutant_tbl') =>
      `select '${tbl}'::text as tbl, '${sch}'::text as sch, '${grantee}'::text as grantee, '${priv}'::text as priv`;
    const NO_DEFACL = `select null::text as grantor, null::text as letters where false`;
    const CLEAN_DEFACL = `select 'postgres'::text as grantor, 'rxtm'::text as letters`;
    // A grant source that yields nothing, for the arm-3 and denominator cases
    // that must isolate their own arm. An empty VALUES list is a syntax error,
    // hence the `where false`.
    const NO_GRANTS = `select null::text as tbl, null::text as sch, null::text as grantee, null::text as priv where false`;
    const SOME_TABLES = `select 'fixture_tbl'::text as tbl`;
    return [
      {
        name: 'authenticated-write-perimeter arm 2 (a synthesised TRUNCATE grant to authenticated is caught, and the violation names the table)',
        fires: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE'), defaclSource: NO_DEFACL }), 'mutant_tbl: TRUNCATE granted to authenticated'),
        silent: viol(writePerimeterSql({ grantSource: grant('authenticated', 'SELECT'), defaclSource: NO_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 2 (the GRANTEE conjunct is not vacuous — service_role TRUNCATE is legitimate and must stay silent)',
        fires: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE'), defaclSource: NO_DEFACL }), 'mutant_tbl'),
        silent: viol(writePerimeterSql({ grantSource: grant('service_role', 'TRUNCATE'), defaclSource: NO_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 2 (the SCHEMA conjunct is not vacuous — docs/52 §9 leaves storage out of scope, so a storage grant must stay silent)',
        fires: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE'), defaclSource: NO_DEFACL }), 'mutant_tbl'),
        silent: viol(writePerimeterSql({ grantSource: grant('authenticated', 'TRUNCATE', 'storage'), defaclSource: NO_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 3a (the postgres default-ACL row regrowing write letters is caught; anon\'s rxtm precedent is clean)',
        fires: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: `select 'postgres'::text as grantor, 'arwdDxtm'::text as letters` }), 'default privileges REGROWING'),
        silent: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: CLEAN_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter arm 3a (a write letter WITHOUT TRUNCATE still fires — the ratchet revoked all four, not just D)',
        fires: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: `select 'postgres'::text as grantor, 'arwxtm'::text as letters` }), 'a write privilege'),
        silent: viol(writePerimeterSql({ grantSource: NO_GRANTS, defaclSource: CLEAN_DEFACL })),
      },
      {
        name: 'authenticated-write-perimeter DENOMINATOR (examining zero tables is a VIOLATION, not a clean result)',
        fires: viol(writePerimeterSql({ grantSource: NO_GRANTS, tableSource: `select null::text as tbl where false`, defaclSource: NO_DEFACL }), 'no-comparisons'),
        silent: viol(writePerimeterSql({ grantSource: NO_GRANTS, tableSource: SOME_TABLES, defaclSource: NO_DEFACL })),
      },
      {
        // THE ONE A SELECT CANNOT FAKE. docs/52 §6b wrote this case and
        // deliberately did not run it, because it is a DDL write; the applying
        // agent was asked to. It was run, twice, against PRODUCTION inside an
        // explicit transaction that rolled back — once before mig 715 and once
        // after — and the rollback was confirmed to have left no table behind
        // (`select count(*) from pg_class where relname='_mutant_default_acl_check'` = 0
        // both times, and the live TRUNCATE count stayed at 0).
        //
        //   begin;
        //     create table public._mutant_default_acl_check (id int);
        //     select privilege_type from information_schema.role_table_grants
        //      where table_schema='public' and table_name='_mutant_default_acl_check'
        //        and grantee='authenticated';
        //   rollback;
        //
        // BEFORE mig 715 → DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
        // AFTER  mig 715 → REFERENCES, SELECT, TRIGGER
        //
        // This is what turns "pg_default_acl says arwdDxtm" from catalogue
        // inference into an observed new table. The letters are not the claim;
        // the table that came out of the database is.
        name: 'authenticated-write-perimeter ratchet (MANUAL, DDL-in-rollback: a NEW table was born truncatable before mig 715 and is not after)',
        manual: 'RUN against production this session. Before 715: a freshly created public table granted authenticated DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE. After 715: REFERENCES,SELECT,TRIGGER only. Both runs rolled back; pg_class confirmed no stray table and the live TRUNCATE count stayed 0. Regrowth OBSERVED, ratchet OBSERVED to hold.',
      },
    ];
  })(),

  // ── mig 720: write-grants-can-actually-write ─────────────────────────────
  // The class: a write grant on an RLS-enabled table with NO PERMISSIVE policy
  // for that command. Postgres refuses it before the grant is read, PostgREST
  // returns SUCCESS WITH NO ERROR, and the client reports a write that never
  // happened. The predicate has FIVE conjuncts — grantee, privilege, RLS on,
  // PERMISSIVE, and a role the caller is in — and one case per conjunct is the
  // point: a probe that fired on every grant in the database would pass a
  // single-conjunct test and be worse than nothing.
  //
  // Every case carries a CONTROL pair (ctrl_tbl.UPDATE, RLS on, policy present)
  // so that a `silent` run is silent because the PREDICATE cleared it, never
  // because the denominator arm had nothing left to compare. Without the
  // control, the RLS-off case would "pass" by tripping no-comparisons instead.
  ...(() => {
    const viol = (sql, like) => `select 1 from (${sql}) x
       where x.violation is not null${like ? ` and x.violation like '%${like}%'` : ''}`;
    const rows = (...rs) => rs.join(' union all ');
    const g = (grantee, priv, tbl = 'mutant_tbl', sch = 'public') =>
      `select '${tbl}'::text as tbl, '${sch}'::text as sch, '${grantee}'::text as grantee, '${priv}'::text as priv`;
    const pol = (cmd, permissive, roles, tbl = 'mutant_tbl') =>
      `select '${tbl}'::text as tbl, '${cmd}'::text as cmd, '${permissive}'::text as permissive, ` +
      `array[${roles.map((r) => `'${r}'`).join(',')}]::text[] as roles`;
    const rls = (on, tbl = 'mutant_tbl') => `select '${tbl}'::text as tbl, ${on} as rls_enabled`;
    // The control: a kept grant that is genuinely usable. Present in every case.
    const CG = g('authenticated', 'UPDATE', 'ctrl_tbl');
    const CP = pol('UPDATE', 'PERMISSIVE', ['authenticated'], 'ctrl_tbl');
    const CR = rls(true, 'ctrl_tbl');
    const NO_GRANTS = `select null::text as tbl, null::text as sch, null::text as grantee, null::text as priv where false`;
    const MUT = 'mutant_tbl.UPDATE: authenticated holds this write grant';
    return [
      {
        name: 'write-grants-can-actually-write (a kept grant with NO policy for its command is caught, and the violation names table.PRIVILEGE — the exact de_deployment_stages/UPDATE shape mig 720 closed)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the COMMAND conjunct is not vacuous — a SELECT policy does not cover UPDATE; a cmd=ALL policy does)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('SELECT', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('ALL', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (a RESTRICTIVE policy is NOT coverage — docs/52 §1 made exactly this mistake and mis-classified 7 tables as live)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'RESTRICTIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['authenticated'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the ROLE conjunct is not vacuous — a policy naming only service_role leaves authenticated refused; {public} covers it)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['service_role'])), rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: rows(CP, pol('UPDATE', 'PERMISSIVE', ['public'])), rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the RLS conjunct is not vacuous — with RLS OFF the grant works and there is nothing to report; the control keeps the denominator non-zero)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(false)) })),
      },
      {
        name: 'write-grants-can-actually-write (the PRIVILEGE conjunct is not vacuous — SELECT is not a write and is never in scope)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'SELECT')), policySource: CP, rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write (the GRANTEE conjunct is not vacuous — service_role bypasses RLS entirely, so its policy-less grants are legitimate)',
        fires: viol(silentNoopWriteSql({ grantSource: rows(CG, g('authenticated', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) }), MUT),
        silent: viol(silentNoopWriteSql({ grantSource: rows(CG, g('service_role', 'UPDATE')), policySource: CP, rlsSource: rows(CR, rls(true)) })),
      },
      {
        name: 'write-grants-can-actually-write DENOMINATOR (comparing zero grant/command pairs is a VIOLATION, not a clean result)',
        fires: viol(silentNoopWriteSql({ grantSource: NO_GRANTS, policySource: CP, rlsSource: CR }), 'no-comparisons'),
        silent: viol(silentNoopWriteSql({ grantSource: CG, policySource: CP, rlsSource: CR })),
      },
      {
        // The one a SELECT cannot fake: real DDL, a real policy, the real
        // catalogue. Run on DEV inside a transaction that rolled back.
        name: 'write-grants-can-actually-write (MANUAL, live DDL-in-rollback on dev: a real granted-but-unpolicied table is caught by the REAL probe, and adding the policy clears it)',
        manual: 'RUN on dev (nmuntxrcdksyhsdywpan) this session, twice, inside begin/rollback: (1) create table public._mutant_noop_write(id int); alter table enable row level security; grant update to authenticated; -- no policy -> the REAL silentNoopWriteSql() returned the violation naming _mutant_noop_write.UPDATE. (2) same, plus `create policy ... for update to authenticated using (true)` -> 0 violations, denominator note printed. Both rolled back; pg_class confirmed no stray table afterwards. See the session report for the exact rows.',
      },
    ];
  })(),
];

// Optional substring filter, so one probe's cases can be re-run on their own
// after a change without waiting out the whole suite. ⚠ A filtered run proves
// only what it ran: the total printed below is of the SELECTED cases, and the
// line above it says so, because "N pass" over a silently narrowed set is the
// padded number this file exists to stop.
const FILTER = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? null;
const SELECTED = FILTER ? CASES.filter((c) => c.name.includes(FILTER)) : CASES;
if (FILTER) {
  console.log(`FILTERED to "${FILTER}": ${SELECTED.length} of ${CASES.length} case(s). NOT a full suite run.`);
  if (SELECTED.length === 0) {
    console.error('FILTER MATCHED NOTHING — a filter that selects no cases is not a pass.');
    process.exit(1);
  }
}

let pass = 0, fail = 0;
for (const c of SELECTED) {
  if (c.manual) { console.log(`  MANUAL  ${c.name}\n            ${c.manual}`); pass++; continue; }
  const fired = (await q(c.fires)).length;
  const silent = (await q(c.silent)).length;
  const ok = fired >= 1 && silent === 0;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}    ${c.name}  (violation→${fired} rows, clean→${silent} rows)`);
  ok ? pass++ : fail++;
}
console.log(`\nmutation test${FILTER ? ` (FILTERED — ${SELECTED.length}/${CASES.length} cases)` : ''}: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
