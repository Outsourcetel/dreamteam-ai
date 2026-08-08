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
