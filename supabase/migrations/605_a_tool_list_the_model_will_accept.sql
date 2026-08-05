-- 605 — a tool list the model will accept.
--
-- Every autonomous work item this platform has ever run failed. All twelve, in
-- one workspace, on one day, with one root error retried three times:
--
--     anthropic_error_400: {"message":"tools: Tool names must be unique."}
--
-- The other eleven read "Cannot run: the step it depends on failed" — a
-- cascade from that single 400. So the honest count of digital employees doing
-- autonomous work today is ZERO, and it is zero for this reason, not because
-- the employees lack knowledge or tools.
--
-- ── Why the names collide ────────────────────────────────────────────────
-- get_agentic_tools_for_de builds each tool name as
--
--     <category>__<action_key>__<first 6 of connector id>
--
-- and its inner loop selects action_definitions on CATEGORY ALONE. One
-- action_key legitimately has several executors — `send_payment_reminder`
-- exists for ERPNext-comment, ERPNext-email, Stripe, QuickBooks and Xero, which
-- the duplicate audit correctly called the right pattern for the DATA model.
-- It is the wrong pattern for a TOOL LIST: all five share a category and an
-- action_key, so all five produce one name.
--
-- Measured on the employee that failed:
--     erp_financials__send_payment_reminder__7f595b   x4
--     erp_financials__send_final_notice__7f595b       x2
--
-- ⚠ I widened this yesterday. Mig 595 registered erpnext_send_invoice_email for
-- both send_payment_reminder and send_final_notice, which is why send_final_
-- notice now doubles. The send_payment_reminder collision pre-dates it — the
-- failures are 2026-08-04 and 595 shipped on the 5th — but the fix is owed
-- either way.
--
-- ── Two defects, one symptom ─────────────────────────────────────────────
-- 1. CROSS-PROVIDER BLEED. Matching on category alone offers a DE connected to
--    ERPNext the Stripe, QuickBooks and Xero reminder tools. Even with unique
--    names those calls could only fail at execution: there is no Stripe
--    connector to run them against. Definitions now match the connector's own
--    provider (provider-agnostic ones — template-bound rows — still apply).
--
-- 2. NON-UNIQUE NAMES. Uniqueness was incidental: it held only while no two
--    definitions shared a category and action_key. The suffix now carries a
--    per-DEFINITION discriminator, so it is structural.
--
-- Both are needed. The provider filter alone still collides on ERPNext's two
-- executors (comment and email); the discriminator alone still offers tools
-- that cannot run.
--
-- ⚠ KNOWN AND NOT FIXED HERE: de-work maps a tool name back to
-- {connector_id, action_key} and connector-hub resolves the definition from
-- that pair. With ERPNext's two send_payment_reminder executors both live, the
-- pair is still ambiguous at EXECUTION time — the same class of bug
-- dunning_action_for solved by binding on execution_key. Closing it means
-- carrying the action_definition_id through the dispatch, which is a change to
-- de-work and connector-hub, not to this function. Named rather than
-- half-fixed.

begin;

do $rebuild$
declare
  v_src text;
  v_new text;
begin
  select pg_get_functiondef(oid) into v_src from pg_proc where proname = 'get_agentic_tools_for_de';

  -- 1. Only this connector's own actions.
  if position('        and category = v_conn.category' in v_src) = 0 then
    raise exception 'category filter anchor not found — the function changed, stop';
  end if;
  v_new := replace(v_src,
    '        and category = v_conn.category',
    '        and category = v_conn.category'
    || E'\n        -- Matching on category ALONE offered an ERPNext-connected employee'
    || E'\n        -- the Stripe/QuickBooks/Xero tools in the same category. Those could'
    || E'\n        -- only ever fail: there is no such connector to run them against.'
    || E'\n        and (provider is null or provider = v_conn.provider or provider = ''template'')');

  -- 2. A discriminator that cannot collide.
  if position('v_suffix := ''__'' || left(replace(v_conn.id::text, ''-'', ''''), 6);' in v_new) = 0 then
    raise exception 'suffix anchor not found — the function changed, stop';
  end if;
  v_new := replace(v_new,
    'v_suffix := ''__'' || left(replace(v_conn.id::text, ''-'', ''''), 6);',
    'v_suffix := ''__'' || left(replace(v_conn.id::text, ''-'', ''''), 6) || left(md5(v_def.id::text), 4);'
    || E'\n        -- Per-DEFINITION, not just per-connector. One action_key can have'
    || E'\n        -- several executors (ERPNext comment vs ERPNext email), and the'
    || E'\n        -- model rejects the ENTIRE call if any two tools share a name.');

  execute v_new;
end;
$rebuild$;

-- ── Prove it on the employee that actually failed ────────────────────────
-- Asserted against live data, not against the shape of the SQL. A uniqueness
-- fix that is never run against the colliding row proves nothing.

do $verify$
declare
  v_tenant uuid := '5bb802e1-8e92-4eef-9a7a-ac348785d43f';
  v_de     uuid := '74c2fbb1-1d2c-4099-9d7d-3225b8e09049';
  v_tools  jsonb;
  v_total  int;
  v_uniq   int;
  v_dupes  text;
begin
  if not exists (select 1 from digital_employees where id = v_de and tenant_id = v_tenant) then
    raise notice 'reference employee absent — skipping the live assertion';
    return;
  end if;

  select get_agentic_tools_for_de(v_tenant, v_de) into v_tools;
  select count(*), count(distinct e->>'name') into v_total, v_uniq
  from jsonb_array_elements(v_tools) e;

  if v_total <> v_uniq then
    select string_agg(nm || ' x' || c, ', ') into v_dupes
    from (select e->>'name' nm, count(*) c from jsonb_array_elements(v_tools) e group by 1 having count(*) > 1) d;
    raise exception 'tool names still collide: %', v_dupes;
  end if;

  if v_total = 0 then
    raise exception 'the employee now has NO tools — the provider filter is too tight';
  end if;

  raise notice 'tool list is unique: % tools, % distinct names', v_total, v_uniq;
end;
$verify$;

commit;
