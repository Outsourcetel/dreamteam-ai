// ============================================================
// THE ACTION GATE — public.decide_action_execution
//
// This is the permission boundary. Every registered action a digital employee
// wants to take goes through this one function, and its answer is the only
// thing standing between "the employee drafted something" and "the employee
// did something to a customer's system". Until this file existed it had no
// automated test at all — only a manual probe inside scripts/golden-path.mjs,
// which runs against a throwaway tenant on the DEV project and therefore
// cannot see production's guardrails, thresholds or trust rows.
//
// The most expensive permission bug this project has shipped — a marketing
// employee that could hire staff (mig 643) — had nothing watching its return.
//
// WHY THIS SUITE IS SAFE TO POINT AT PRODUCTION:
// decide_action_execution is declared STABLE. It reads configuration and
// returns a verdict; it writes nothing, and execute_action is never called
// here. Asking the gate a question is not the same as acting on the answer.
// The suite therefore ASKS, using helpers/adminQuery.ts, whose runQuery()
// refuses anything that is not a lone SELECT/WITH. Nothing is created: the
// tenants and employees probed are discovered from existing rows.
//
// TWO KINDS OF ASSERTION, deliberately mixed:
//   · BEHAVIOURAL — call the gate with real production config and check the
//     verdict. This is what actually proves the floor holds.
//   · STRUCTURAL — assert on the function body where behaviour cannot be
//     reached read-only. Exactly one thing falls in this bucket, the STOP
//     button, and its test says so out loud rather than pretending otherwise.
//
// THE PAIRING RULE. Nearly every test below changes ONE input and asserts the
// verdict flips. A gate that returns "ask a human" to everything passes any
// single-sided test and is completely broken — the employee can do nothing.
// So every gate is proved by the pair (it fires / it does not fire), not by
// the half that is comfortable to assert.
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runQuery, scalar, adminTokenAvailable } from './helpers/adminQuery';

if (!adminTokenAvailable()) {
  throw new Error(
    'action-gate needs SUPABASE_ACCESS_TOKEN in .env.local (the same token scripts/db-query.mjs uses). ' +
    'Failing loudly rather than skipping: a permission-boundary suite that silently does not run is worse than no suite.',
  );
}

// Collapses newlines so hand-written SQL can be indented. ⚠ NO `--` comments
// inside these strings — the collapse would swallow the rest of the statement.
const q = (s: string) => s.replace(/\s+/g, ' ').trim();
const lit = (v: string | null | undefined) =>
  v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;

/** The exact shape every caller destructures. */
interface Verdict {
  decision: string;
  guardrail_rule_id: string | null;
  guardrail_rule: string | null;
  trust_level: number | null;
  reasoning: string;
}

interface Probe {
  tenant: string;
  de?: string | null;
  label?: string;
  category?: string | null;
  destructive: boolean | null;
  amountCents?: number | null;
  actionType?: string;
  content?: string | null;
}

// Deliberately bland: the label is one of the strings guardrails are matched
// against, so a probe label that reads like customer-facing copy would trip a
// real customer's rule and turn this suite red for a reason that is not a bug.
const LABEL = 'Regression probe from the action-gate test suite';

/** Asks the gate. One statement, one line — no q() here, because the
 *  interpolated values come from production rows and collapsing whitespace
 *  inside a guardrail phrase would change what is being matched. */
async function decide(p: Probe): Promise<Verdict> {
  const args = [
    `${lit(p.tenant)}::uuid`,
    `${lit(p.label ?? LABEL)}::text`,
    `${lit(p.category ?? null)}::text`,
    `${p.destructive === null || p.destructive === undefined ? 'null' : String(p.destructive)}::boolean`,
    `${lit(p.de ?? null)}::uuid`,
    `${p.amountCents === null || p.amountCents === undefined ? 'null' : String(Math.trunc(p.amountCents))}::bigint`,
    `${lit(p.actionType ?? 'action_execute')}::text`,
    `${lit(p.content ?? null)}::text`,
  ].join(', ');
  const rows = await runQuery<{ v: Verdict }>(`select public.decide_action_execution(${args}) as v`);
  return rows[0].v;
}

/** A workspace + employee the trust dial has ARMED for action_execute, i.e.
 *  one where a safe action genuinely auto-executes. Discovered, not hardcoded,
 *  and resolved through the REAL resolver rather than a reimplementation of
 *  its cascade — a copy of that logic here could drift and still agree. */
interface Pair { tenant_id: string; de_id: string; source_category: string | null; max_amount_cents: number | null }

let armed: Pair | null = null;
let floorProbe: Pair;
let body = '';
let scopedRules: {
  tenant_id: string; scoped_de: string; other_de: string; rule_name: string; frag: string;
  scoped_decision: string; scoped_rule: string | null; other_rule: string | null;
}[] = [];

beforeAll(async () => {
  const [armedRows, anyRows, def, scoped] = await Promise.all([
    runQuery<Pair>(q(`
      select a.tenant_id::text as tenant_id, a.de_id::text as de_id,
             a.source_category, r.max_amount_cents
        from de_autonomy a
        cross join lateral resolve_de_autonomy_chain(
            a.tenant_id,
            array[case when nullif(a.source_category, '') is not null
                       then 'action:' || a.source_category end,
                  'action_execute', 'action_execute'],
            a.de_id, a.source_category) r
       where a.action_type = 'action_execute' and a.enabled and a.de_id is not null
         and not public.workforce_autonomy_paused(a.tenant_id)
         and r.enabled
       order by a.tenant_id, a.de_id
       limit 1`)),
    runQuery<Pair>(q(`
      select d.tenant_id::text as tenant_id, d.id::text as de_id,
             null::text as source_category, null::bigint as max_amount_cents
        from digital_employees d
       where not public.workforce_autonomy_paused(d.tenant_id)
       order by d.tenant_id, d.id
       limit 1`)),
    scalar<string>(q(`
      select pg_get_functiondef(p.oid) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'decide_action_execution' limit 1`)),
    // Both probes computed server-side in ONE round trip: the same phrase put
    // to the employee the rule is scoped to, and to a DIFFERENT employee in the
    // same workspace. Fragments containing a semicolon are excluded so the
    // single-statement guard in runQuery cannot be tripped by customer data —
    // written as chr(59) because a literal one here trips that same guard.
    runQuery<typeof scopedRules[number]>(q(`
      select g.tenant_id::text as tenant_id, g.scope_ref as scoped_de, o.other_de,
             g.rule as rule_name, split_part(g.pattern, '|', 1) as frag,
             (decide_action_execution(g.tenant_id, ${lit(LABEL)}, null, false,
                g.scope_ref::uuid, null::bigint, 'action_execute',
                split_part(g.pattern, '|', 1)))->>'decision' as scoped_decision,
             (decide_action_execution(g.tenant_id, ${lit(LABEL)}, null, false,
                g.scope_ref::uuid, null::bigint, 'action_execute',
                split_part(g.pattern, '|', 1)))->>'guardrail_rule' as scoped_rule,
             (decide_action_execution(g.tenant_id, ${lit(LABEL)}, null, false,
                o.other_de::uuid, null::bigint, 'action_execute',
                split_part(g.pattern, '|', 1)))->>'guardrail_rule' as other_rule
        from guardrail_rules g
        join lateral (select d2.id::text as other_de from digital_employees d2
                       where d2.tenant_id = g.tenant_id and d2.id::text <> g.scope_ref
                       order by d2.id limit 1) o on true
       where g.active and g.severity = 'blocking' and g.scope = 'employee'
         and g.rule_type in ('blocked_phrase', 'blocked_topic')
         and g.pattern is not null and g.scope_ref ~ '^[0-9a-fA-F-]{36}$'
         and strpos(split_part(g.pattern, '|', 1), chr(59)) = 0
         and not public.workforce_autonomy_paused(g.tenant_id)
       order by g.tenant_id, g.rule`)),
  ]);

  armed = armedRows[0] ?? null;
  if (anyRows.length === 0) {
    throw new Error('no unpaused workspace with a digital employee exists — the gate cannot be probed at all');
  }
  // The destructive floor must hold for ANY employee, so it is proved against
  // whatever exists. The armed pair is strictly better (it proves the floor
  // holds even where trust WOULD have allowed the action), so prefer it.
  floorProbe = armed ?? anyRows[0];
  body = def.replace(/\s+/g, ' ');
  scopedRules = scoped;
}, 60000);

describe('the action gate — decide_action_execution', () => {
  // ── The shape callers depend on ────────────────────────────────────────
  it('has exactly one overload, and the money parameter is named p_amount_cents', async () => {
    const rows = await runQuery<{ args: string }>(q(`
      select pg_get_function_identity_arguments(p.oid) as args from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'decide_action_execution'`));
    // Every caller invokes this through PostgREST with NAMED arguments. A
    // second overload makes that resolution ambiguous, and the dev project has
    // carried a stale one (see scripts/dev-sync.mjs) that lacks p_content —
    // the parameter the guardrail scan reads. Two overloads means the gate you
    // tested and the gate that ran can be different functions.
    expect(rows.length, 'more than one overload — named-argument dispatch is ambiguous').toBe(1);
    // ⚠ p_amount_cents is the ONE name every money gate reads. Rename it and
    // the .rpc() calls keep compiling, keep succeeding, and silently pass NULL
    // — which disables the approval threshold, the spend caps and the trust
    // dollar-ceiling all at once, with no error anywhere.
    expect(rows[0].args).toContain('p_amount_cents bigint');
    expect(rows[0].args, 'p_content is what lets guardrails see what the employee wrote').toContain('p_content text');
    expect(rows[0].args).toContain('p_destructive boolean');
  });

  it('is STABLE, SECURITY DEFINER, with a pinned search_path', async () => {
    const [r] = await runQuery<{ vol: string; secdef: boolean; cfg: string | null }>(q(`
      select p.provolatile as vol, p.prosecdef as secdef, p.proconfig::text as cfg
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'decide_action_execution'`));
    // STABLE is a promise: asking the gate cannot change anything. It is what
    // makes this whole suite safe to run against production, and it is what
    // lets callers ask before acting. A VOLATILE gate has side effects.
    expect(r.vol, 'the gate became VOLATILE — asking it now changes state').toBe('s');
    // SECURITY DEFINER is required (it reads guardrails and trust rows across
    // RLS), which makes the pinned search_path load-bearing, not cosmetic.
    expect(r.secdef).toBe(true);
    expect(r.cfg ?? '').toMatch(/search_path=public/);
  });

  it('is not reachable by anon', async () => {
    // anon has a NULL auth.uid(). The gate takes p_tenant_id from its caller
    // and does not check it, so EXECUTE is the only thing scoping who can ask.
    //
    // ⚠ KNOWN, DELIBERATELY NOT ASSERTED: `authenticated` DOES hold EXECUTE
    // today, while all three of its helpers (workforce_autonomy_paused,
    // guardrail_rules_for_de, resolve_de_autonomy_chain) do not, and no
    // browser code calls this RPC — the only src/ mention is a comment. A
    // signed-up user who knows a tenant UUID can therefore read back another
    // workspace's guardrail rule NAMES and its dollar approval threshold via
    // `guardrail_rule` and `reasoning`. That is a read-only cross-tenant
    // leak, not a write path, so the unguarded_secdef_writers sweep in
    // knowledge-acl-invariants.test.ts cannot see it. Recorded here rather
    // than asserted because revoking the grant is a migration, and this file
    // does not get to decide that.
    const rows = await runQuery<{ proname: string }>(q(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'decide_action_execution'
         and has_function_privilege('anon', p.oid, 'EXECUTE')`));
    expect(rows.map(r => r.proname)).toEqual([]);
  });

  // ── 0. THE STOP BUTTON ─────────────────────────────────────────────────
  it('checks the workspace STOP button before anything else', async () => {
    // ⚠ THE ONE STRUCTURAL TEST IN THIS FILE, AND WHY.
    // The pause lives in workforce_trust_posture.autonomy_paused. That table
    // holds ZERO rows in production — no workspace is stopped — so there is
    // no read-only way to make this branch fire, and this suite must not
    // write. What CAN be proved without writing is the property migration 623
    // exists for: the pause is evaluated ABOVE the destructive floor, so it
    // stops everything including what would otherwise have been allowed. A
    // later edit that moves it down beside the trust dial fails here.
    expect(body, 'the gate no longer consults the pause at all')
      .toContain('workforce_autonomy_paused(p_tenant_id)');

    const firstReturn = body.indexOf('return jsonb_build_object');
    expect(firstReturn).toBeGreaterThan(-1);
    expect(
      body.slice(firstReturn, firstReturn + 140),
      'the first thing the gate can return is no longer the pause verdict — something now runs above the stop button',
    ).toContain('human_gated_paused');
    expect(
      body.indexOf('workforce_autonomy_paused(p_tenant_id)'),
      'the pause is evaluated after the destructive floor — a stopped workspace would still be deciding',
    ).toBeLessThan(body.indexOf("'human_gated_destructive'"));
  });

  it('treats a workspace with no posture row as NOT paused', async () => {
    // The behavioural half that IS reachable. Every action in every workspace
    // calls this predicate, and almost no workspace has a row. If a missing
    // row read as `true` the entire product would stop; if the column stopped
    // being honoured, the stop button would be decorative. Both directions of
    // that coalesce matter, and this pins the default one.
    const paused = await scalar<boolean>(
      `select public.workforce_autonomy_paused('11111111-2222-3333-4444-555555555555'::uuid)`);
    expect(paused, 'a workspace that never touched the stop button reads as stopped').toBe(false);
  });

  // ── 1. THE DESTRUCTIVE FLOOR ───────────────────────────────────────────
  it('gates a destructive action even for an employee the trust dial has armed', async () => {
    // This is the floor, and the probe is chosen so it cannot pass for a
    // boring reason: `floorProbe` prefers an employee whose dial is ARMED, so
    // the identical SAFE call auto-executes (proved in the next test). Same
    // workspace, same employee, same label, same category — the destructive
    // flag is the only difference, and it must be enough on its own.
    const v = await decide({
      tenant: floorProbe.tenant_id, de: floorProbe.de_id,
      category: floorProbe.source_category, destructive: true,
    });
    expect(v.decision, `destructive action was not gated: ${JSON.stringify(v)}`)
      .toBe('human_gated_destructive');
    // The floor is a platform property, not a rule someone configured. If it
    // ever starts citing a guardrail or a trust level, it has been moved.
    expect(v.guardrail_rule).toBeNull();
    expect(v.trust_level).toBeNull();
  });

  it('does NOT put a safe action on the destructive floor', async () => {
    // The other half. A gate that refuses everything passes the test above and
    // is just as broken — the employee can never do anything, and the product
    // is a very expensive suggestion box.
    const v = await decide({
      tenant: floorProbe.tenant_id, de: floorProbe.de_id,
      category: floorProbe.source_category, destructive: false,
    });
    expect(v.decision, `a non-destructive action hit the destructive floor: ${JSON.stringify(v)}`)
      .not.toBe('human_gated_destructive');
    expect(['auto_executed', 'human_gated_trust', 'guardrail_blocked']).toContain(v.decision);
  });

  it('gates when the caller does not say whether the action is destructive', async () => {
    // coalesce(p_destructive, true). A caller that forgets the flag — or reads
    // it from a registry row where it is null — must land on the floor, not
    // sail past it. Unknown risk is treated as destructive, which is the only
    // safe reading and is easy to lose in a rewrite.
    const v = await decide({
      tenant: floorProbe.tenant_id, de: floorProbe.de_id,
      category: floorProbe.source_category, destructive: null,
    });
    expect(v.decision, 'an unspecified destructive flag did not fail closed').toBe('human_gated_destructive');
  });

  it('puts the destructive floor above the guardrails', async () => {
    // Ordering is what the human sees. A destructive action that also trips a
    // guardrail must be reported as destructive, because that is the reason it
    // can never auto-execute — the guardrail is merely another reason today.
    const r = scopedRules.find(x => x.scoped_decision === 'guardrail_blocked');
    expect(r, 'no employee-scoped blocking guardrail fires anywhere — the guardrail probes below are vacuous').toBeTruthy();
    const v = await decide({
      tenant: r!.tenant_id, de: r!.scoped_de, category: null,
      destructive: true, content: r!.frag,
    });
    expect(v.decision, `guardrail-matching content outranked the destructive floor: ${JSON.stringify(v)}`)
      .toBe('human_gated_destructive');
  });

  // ── 2. THE GATE CAN SAY YES ────────────────────────────────────────────
  it('auto-executes a safe action where the trust dial is armed', async () => {
    // The strongest form of "it does not refuse everything": somewhere in
    // production, a real employee with a real trust row genuinely gets to act
    // unattended on a non-destructive, non-monetary action. If this goes red
    // because no workspace has an armed action_execute dial any more, that is
    // worth knowing too — it means the autonomy the product sells is switched
    // off everywhere.
    expect(
      armed,
      'no workspace anywhere has an armed action_execute trust dial, so the gate can never say yes — either the dial was turned off everywhere, or resolve_de_autonomy_chain stopped resolving',
    ).toBeTruthy();
    const v = await decide({
      tenant: armed!.tenant_id, de: armed!.de_id,
      category: armed!.source_category, destructive: false,
    });
    expect(v.decision, `an armed employee could not act on a safe action: ${JSON.stringify(v)}`)
      .toBe('auto_executed');
  });

  it('defaults to asking a human for an employee with no trust rule', async () => {
    // resolve_de_autonomy_chain has NO workspace tier by design: an employee
    // with no rule for this action resolves to false, never to a permissive
    // default. Probed against a workspace UUID that does not exist, so nothing
    // configured anywhere can accidentally make this pass.
    const v = await decide({
      tenant: '11111111-2222-3333-4444-555555555555', de: null,
      category: null, destructive: false,
    });
    expect(v.decision, 'an unknown workspace resolved to something other than "ask a human"')
      .toBe('human_gated_trust');
  });

  // ── 3. MONEY ───────────────────────────────────────────────────────────
  it('reads the amount from p_amount_cents and from nothing else', async () => {
    // The pair that proves it. Two calls, identical in every input except the
    // amount parameter: one auto-executes, one does not. If the money gates
    // were reading anything other than this parameter — or reading nothing,
    // which is how they were once silently disabled — both calls would agree.
    expect(armed, 'no armed pair to prove the money gates against').toBeTruthy();
    const withoutAmount = await decide({
      tenant: armed!.tenant_id, de: armed!.de_id,
      category: armed!.source_category, destructive: false, amountCents: null,
    });
    expect(withoutAmount.decision).toBe('auto_executed');

    // One cent — below every threshold in this workspace. It still must not
    // auto-execute, because this trust row carries no dollar ceiling, and a
    // trust row with no ceiling has not earned an unbounded one. Where a
    // ceiling does exist, go one cent over it.
    const over = armed!.max_amount_cents === null ? 1 : Number(armed!.max_amount_cents) + 1;
    const withAmount = await decide({
      tenant: armed!.tenant_id, de: armed!.de_id,
      category: armed!.source_category, destructive: false, amountCents: over,
    });
    expect(
      withAmount.decision,
      `adding a money amount did not change the verdict — the money gates are not reading p_amount_cents: ${JSON.stringify(withAmount)}`,
    ).toBe('human_gated_trust');
    if (armed!.max_amount_cents === null) {
      // Gated by the missing ceiling, NOT by the workspace threshold — one
      // cent is nowhere near it. Naming the rule here distinguishes the two.
      expect(
        withAmount.guardrail_rule,
        'a trust row with no dollar ceiling auto-executed a monetary action',
      ).toBeNull();
    }
  });

  it('holds the $10,000 platform default approval threshold to the cent', async () => {
    // coalesce(v_threshold, 1000000): a workspace that has never configured a
    // require_approval_over_cents rule still gets a $10,000 ceiling. Probed
    // against a workspace UUID that does not exist, so no customer's rule can
    // move the boundary this asserts. One cent either side, and the reason the
    // human is asked changes — that is the boundary, not a rounding artefact.
    const T = '11111111-2222-3333-4444-555555555555';
    const at = await decide({ tenant: T, de: null, category: null, destructive: false, amountCents: 1_000_000 });
    expect(at.guardrail_rule, 'an amount AT the default threshold tripped the approval rule').toBeNull();

    const over = await decide({ tenant: T, de: null, category: null, destructive: false, amountCents: 1_000_001 });
    expect(over.decision).toBe('human_gated_trust');
    expect(
      over.guardrail_rule,
      'one cent over the $10,000 default did not trip require_approval_over_cents — the default threshold is gone or has moved',
    ).toBe('require_approval_over_cents');
  });

  it('leaves no money amount in the action registry under any other name', async () => {
    // ⚠ THE FAILURE MODE THAT HAS NO ERROR MESSAGE. connector-hub reads the
    // amount out of a registry param named EXACTLY `amount_cents` and passes
    // it as p_amount_cents. An action that declares its money as `total_cents`
    // or `amount` still validates, still executes, and reaches the gate with
    // p_amount_cents = NULL — which turns off the approval threshold, the
    // spend caps and the trust ceiling for that action alone, silently.
    const rows = await runQuery<{ name: string }>(q(`
      select distinct p->>'name' as name
        from action_definitions ad, jsonb_array_elements(ad.param_schema) p
       where jsonb_typeof(ad.param_schema) = 'array'
         and p->>'name' ~* '(^|_)(amount|amounts|cents|price|prices|total|totals|money|charge|fee|cost)($|_)'
         and p->>'name' <> 'amount_cents'
         and p->>'name' <> 'default_price_list'`));
    // default_price_list is allowlisted above: it is an ERPNext price-list
    // NAME, not a sum of money, so there is nothing for the gate to read.
    expect(
      rows.map(r => r.name),
      'a registered action carries a money amount the gate will never see — rename the param to amount_cents',
    ).toEqual([]);

    const withAmount = await scalar<number>(q(`
      select count(*)::int from action_definitions ad
       where jsonb_typeof(ad.param_schema) = 'array'
         and exists (select 1 from jsonb_array_elements(ad.param_schema) p
                      where p->>'name' = 'amount_cents')`));
    expect(withAmount, 'no action declares amount_cents at all — the check above is vacuous').toBeGreaterThan(0);
  });

  it('is passed an amount by every caller', async () => {
    // Omitting p_amount_cents from an .rpc() call compiles, runs, returns a
    // verdict, and disables all three money gates for that call site. It has
    // happened (see the comment at the connector-hub call site: "Passing null
    // here is what silently disabled all three"). A caller with no money
    // concept must still pass `p_amount_cents: null` — writing the null down
    // is the whole point, because forgetting it looks identical.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join('supabase', 'functions'));

    const missing: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const re = /rpc\(\s*['"]decide_action_execution['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        sites += 1;
        // The argument object is short at every site; 900 chars covers it
        // comfortably without running into the next statement.
        const window = src.slice(m.index, m.index + 900);
        for (const need of ['p_tenant_id', 'p_destructive', 'p_amount_cents']) {
          if (!window.includes(need)) missing.push(`${f}:${need}`);
        }
      }
    }
    expect(sites, 'no call site found — the scan is looking in the wrong place').toBeGreaterThanOrEqual(2);
    expect(missing, 'a caller reaches the gate without telling it everything the gate needs').toEqual([]);
  });

  // ── 4. GUARDRAILS ──────────────────────────────────────────────────────
  it('scans what the employee wrote, not only the label', async () => {
    // Migration 495. Until it landed, the text guardrails matched was the
    // server-composed label plus the category — two fixed constants per
    // operation — so a rule like "no pricing commitments in writing" was
    // structurally incapable of firing on a write-back. The pair: identical
    // call, content present vs absent.
    const r = scopedRules.find(x => x.scoped_decision === 'guardrail_blocked');
    expect(r, 'no employee-scoped blocking guardrail fires anywhere in production').toBeTruthy();

    const withContent = await decide({
      tenant: r!.tenant_id, de: r!.scoped_de, category: null,
      destructive: false, content: r!.frag,
    });
    expect(withContent.decision, `guardrail did not fire on the written content: ${JSON.stringify(withContent)}`)
      .toBe('guardrail_blocked');
    expect(withContent.guardrail_rule).toBe(r!.rule_name);
    expect(withContent.guardrail_rule_id, 'a blocked action must name which rule blocked it').toBeTruthy();

    const withoutContent = await decide({
      tenant: r!.tenant_id, de: r!.scoped_de, category: null,
      destructive: false, content: null,
    });
    expect(
      withoutContent.guardrail_rule,
      'the same call blocks with the content removed — the guardrail is matching the label, not the writing',
    ).not.toBe(r!.rule_name);
  });

  it('keeps an employee-scoped guardrail off other employees in the same workspace', async () => {
    // The WAVE-1 fix in the body: guardrail_rules_for_de resolves workspace +
    // this employee's own employee/department rules, instead of every rule in
    // the tenant. Scoped the other way this gate is not wrong so much as
    // useless — one employee's "no pricing commitments" would silence support,
    // billing and everyone else, and the rules would be turned off.
    const firing = scopedRules.filter(x => x.scoped_decision === 'guardrail_blocked');
    expect(firing.length, 'no employee-scoped rule fires for its own employee — nothing to prove scope with').toBeGreaterThan(0);
    const leaked = firing
      .filter(x => x.other_rule === x.rule_name)
      .map(x => `${x.rule_name} leaked from ${x.scoped_de.slice(0, 8)} to ${x.other_de.slice(0, 8)}`);
    expect(leaked, 'an employee-scoped guardrail fired for a different employee').toEqual([]);
  });

  // ── 5. THE TOKEN EVERY CALLER SWITCHES ON ──────────────────────────────
  it('says auto_executed in exactly one place, below every gate', async () => {
    // Every caller decides with `decision !== 'auto_executed'`. That single
    // string is the whole permission, so a second place that can emit it is a
    // second way to be allowed. There must be one, and it must sit after the
    // pause, the destructive floor, the guardrail loop and the money checks.
    const hits = body.match(/'decision',\s*'auto_executed'/g) ?? [];
    expect(hits.length, 'more than one branch can grant permission').toBe(1);

    const iAuto = body.search(/'decision',\s*'auto_executed'/);
    const order: [string, number][] = [
      ['the stop button', body.indexOf('workforce_autonomy_paused(p_tenant_id)')],
      ['the destructive floor', body.indexOf("'human_gated_destructive'")],
      ['the guardrail loop', body.indexOf('guardrail_rules_for_de')],
      ['the approval threshold', body.indexOf("'require_approval_over_cents'")],
      ['the spend caps', body.indexOf('spend_cap_daily_cents')],
    ];
    for (const [name, at] of order) {
      expect(at, `${name} is no longer in the gate at all`).toBeGreaterThan(-1);
      expect(at, `${name} now runs AFTER permission is granted`).toBeLessThan(iAuto);
    }
  });
});
