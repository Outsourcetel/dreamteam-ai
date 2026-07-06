-- ============================================================
-- Migration 043: THE REAL FINANCE DIGITAL EMPLOYEE — the SECOND proof
-- of the configuration-only genericity claim, following directly from
-- the Account DE build (migration 037, commit 6962a31).
--
-- Context (see memory/gap_analysis_roadmap.md items 19-22 — Finance
-- was the weakest-scored function, originally audited at ~10% built,
-- almost entirely unconnected UI — and memory/feedback_de_genericity_
-- test.md, the standing test applied before every new DE build): the
-- persona/trigger/action/trust/guardrail machinery all now exist
-- generically (027 category contracts, 029 access grants, 031 charter,
-- 035 action layer, 036 trigger layer, 037 create_digital_employee,
-- 042 staleness watchdog). Standing up Finance is "configuration on
-- top of existing machinery," exactly like Jordan (Account DE) — this
-- migration is the acceptance test for that claim on a SECOND
-- department, not just a repeat assertion.
--
-- THE ONE RULE: use ONLY existing generic machinery. No new tables
-- beyond what 037/042 already generalized, no new step primitives, no
-- new composition functions, no `if category = 'erp_financials' then`
-- business-logic branch anywhere. Where the existing mechanism has a
-- genuine, honest gap (documented below), the gap is stated plainly —
-- not silently patched with a bespoke workaround.
--
-- RESEARCH GROUNDING FOR THE DUNNING CADENCE (cited, applied to the
-- configuration choices below, not invented per-department logic):
-- real 2026 dunning/collections practice uses staged escalation —
-- early courtesy/gentle reminders are low-risk and safe to automate
-- once trust is earned; a "final notice" is a materially stronger
-- action that should sit at a higher bar; anything resembling a
-- credit hold, collections-agency referral, or legal-threat language
-- must ALWAYS require a human, regardless of trust tier — matching
-- this platform's existing destructive-always-gates safety floor
-- (migration 035) exactly. High-value accounts should also always
-- route to a human rather than auto-send, regardless of trust tier —
-- mapped onto this platform's EXISTING require_approval_over_cents
-- guardrail pattern (015/guardrailApi.ts), applied at a Finance-
-- appropriate account-value threshold via the existing generic
-- `decision` step primitive (019/031), not a new gating mechanism.
--
-- WHAT IS CONFIGURATION-ONLY (reusing 037's own machinery, unmodified):
--   - digital_employees — one new persona row via the SAME insert
--     shape create_digital_employee itself uses (service-role seed
--     context, matching 037's own pattern for Jordan). NO new "add a
--     DE" capability needed this time — 037 already built it.
--   - connectors (017) — one new erp_financials-category, provider=
--     'template' connector, pointed at the SAME shared verification
--     adapter template 036/037 already used (jsonplaceholder-backed,
--     safe test target) — reused, not a new template. Deliberately
--     NOT payroll_hcm; deliberately NOT a crm read grant either (see
--     the access-grant note in section 2b — this DE does not need to
--     know "who to contact," it acts on the invoice/account record it
--     already has via erp_financials, matching the same narrow-scope
--     principle 037 applied to Jordan).
--   - data_access_grants (029) — erp_financials: write_back only.
--   - action_definitions (035) — THREE new rows (send_payment_reminder,
--     send_final_notice, flag_for_collections), category=
--     erp_financials, provider=template, pointed at the SAME shared
--     template's `actions` map (new action BINDINGS added to that
--     map — pure configuration, zero new adapter code, same pattern
--     037 used for log_checkin_note).
--   - trust_policies / de_autonomy (025/035/036) — a fresh
--     source_category='erp_financials'-scoped action_execute policy
--     started at level 0 (baseline/gated) — the SAME earned-trust
--     ladder migration 025 built for invoice_auto_send, reused via
--     the action_execute/source_category generalization 036 added,
--     NOT a new trust category invented for this department.
--   - guardrail_rules (015) — one blocked_phrase rule extending the
--     EXISTING pattern to legal-threat language, and one
--     require_approval_over_cents rule at a Finance-appropriate
--     account-value threshold (both reuse the exact rule_type
--     vocabulary migration 015 already defined).
--   - de_playbook_charter (031) + playbook_definitions/playbook_
--     versions (019/031) — TWO real playbooks (dunning_payment_
--     reminder, dunning_final_notice), authored entirely from EXISTING
--     step primitives (check_account -> decision -> connector_action /
--     checklist -> complete), zero new step types.
--   - playbook_event_rules (021) — TWO rows, BOTH using the ALREADY-
--     EXISTING 'invoice_overdue' event key (no enum widening needed —
--     dispatch_due_triggers' invoice_overdue branch has taken an
--     overdue_days param since migration 021), one at a short
--     threshold (reminder stage) and one at a longer threshold (final-
--     notice stage) — reusing the SAME event key, SAME dedup/cooldown
--     mechanism, just two configuration rows with different params,
--     exactly how a human would configure two stages of one cadence.
--   - staleness_policies (042) — one new tenant-overridable policy row
--     for target_kind='overdue_invoice_unattended' (see the honest
--     note in section 2 on why this needed one small new lookup
--     branch, not zero code, matching 042's own stated honest limit).
--
-- WHAT THIS DOES NOT DO / HONEST GAPS FOUND (documented, not hidden):
--   - decide_action_execution's trust dial is ONE boolean per
--     (tenant, category) — it has no notion of "this dial applies to
--     action A but not action B within the same category." The only
--     OTHER lever the existing mechanism offers for "a stronger action
--     needs a higher bar" is risk.destructive (035's platform floor).
--     So: send_payment_reminder is destructive=false (gated only by
--     the erp_financials trust dial, can earn auto-execution);
--     send_final_notice AND flag_for_collections are BOTH
--     destructive=true (always human-gated, no trust override). This
--     honestly collapses the brief's three-tier ask ("reminder auto-
--     capable / final-notice higher-bar / collections always-gated")
--     into the platform's real two-tier vocabulary (auto-capable vs.
--     always-human) — final-notice does not get an INTERMEDIATE bar
--     beyond "always human," because no such intermediate mechanism
--     exists today. Always-human IS a stricter bar than any trust
--     level, so the requirement ("a higher bar") is honestly satisfied,
--     just not with a third distinct tier. Flagged here rather than
--     inventing a new per-action-key trust column to manufacture a
--     tier that doesn't otherwise exist in this system yet.
--   - decide_action_execution does not evaluate guardrail_rules'
--     require_approval_over_cents/threshold at all (only the invoice-
--     generation-specific client/playbook-step code paths do, keyed on
--     ctx.invoice_amount_cents). The high-value-account gate for this
--     build is therefore implemented as a `decision` step (on the
--     account's arr_cents, already populated into run context by the
--     existing check_account step) inside the dunning playbooks
--     themselves — reusing the fully generic decision primitive, NOT
--     a new composition-function feature. This is an honest, existing-
--     primitive-only way to satisfy "high-value accounts always route
--     to a human," but it means the guardrail is playbook-authored
--     configuration, not a change to the universal action_execute
--     composition function every category automatically inherits.
--   - The playbook engine's context threading is account_id-scoped
--     only (startDefinitionRunServer never threads an invoice id/
--     amount into ctx) — this build works within that constraint by
--     branching on the ACCOUNT's arr_cents (already available) rather
--     than the individual invoice's amount, which is an honest
--     narrowing, not a full per-invoice-amount guardrail.
--   - Only one connector (a jsonplaceholder-backed test target) and
--     three actions exist — no real accounting/ERP system (Xero,
--     QuickBooks, etc.) is actually connected. The genericity claim is
--     about the MECHANISM, not integration breadth, exactly as stated
--     for the Account DE and the action layer before it.
-- ============================================================

-- ============================================================
-- 1. THE PERSONA — the Finance DE, for the live working-pipeline
-- tenant (Acme Telecom). Demo tenant untouched. Uses the SAME direct-
-- insert seed shape 037 used for Jordan (service-role seed context,
-- not the create_digital_employee RPC, since a migration has no user
-- session) — idempotent and re-runnable. Name/persona chosen to avoid
-- any collision with the demo tenant's roster (Alex/Casey/Morgan/
-- Riley/Avery are all taken there).
-- ============================================================
do $$
declare
  v_tenant uuid := 'a1b2c3d4-0000-0000-0000-000000000001';
  v_de     uuid := 'de000000-0000-0000-0000-000000000401';
  v_template_id uuid := 'aea9ec1a-77f0-4e4d-a2fe-b3d3ea830303';  -- SAME shared verification adapter template 036/037 already used
  v_connector uuid := 'c0000000-0000-0000-0000-000000000401';
  v_action_reminder uuid;
  v_action_final uuid;
  v_action_collections uuid;
  v_playbook_reminder uuid;
  v_playbook_final uuid;
begin
  if not exists (select 1 from tenants where id = v_tenant) then return; end if;

  -- ── 1a. Persona row — "Sasha Reyes," the Finance DE. Not Alex/
  -- Casey/Morgan/Riley/Avery (demo tenant characters) or Jordan
  -- (existing live Account DE persona_name).
  insert into digital_employees (
    id, tenant_id, name, persona_name, description, category, department,
    status, lifecycle_status, trust_level, confidence_threshold, required_approval
  ) values (
    v_de, v_tenant, 'Finance DE', 'Sasha Reyes',
    'Owns invoice follow-through and dunning cadence — notices overdue invoices, sends staged reminders, and hands anything involving a final notice, a high-value account, or a collections/credit-hold decision to a human. Data access limited to billing/financial records by default — no CRM, no payroll/HR systems.',
    'Customer', 'Finance',
    'active', 'published', 'supervised', 75, false
  )
  on conflict (id) do nothing;

  -- ── 1b. Connector — erp_financials category, provider=template,
  -- reusing the SAME shared jsonplaceholder-backed verification
  -- template (aea9ec1a-...) migration 036/037 already proved works —
  -- shaped here as an invoices/AR test surface. No new adapter code:
  -- the template's existing ops/actions map is EXTENDED (section 1c
  -- below), never replaced.
  insert into connectors (id, tenant_id, provider, category, display_name, base_url, status, access_mode, template_id, config)
  values (
    v_connector, v_tenant, 'template', 'erp_financials',
    'AR Ledger (verification: jsonplaceholder /comments as invoice/AR records)',
    'https://jsonplaceholder.typicode.com', 'connected', 'fetch_only', v_template_id,
    '{}'::jsonb
  )
  on conflict (id) do nothing;

  -- ── 1c. data_access_grants — erp_financials: write_back only.
  -- Explicitly NOT crm (this DE does not need "who to contact" lookup
  -- — the invoice/account record already carries the account name;
  -- adding a crm grant would widen scope without a concrete need, so
  -- it is deliberately withheld, same discipline as 037 withholding
  -- financial grants from Jordan). Explicitly NOT payroll_hcm/billing-
  -- as-payroll — billing here means AR/invoicing, never HR.
  insert into data_access_grants (tenant_id, subject_kind, subject_id, resource_kind, resource_category, permission, granted_by, note)
  values (v_tenant, 'de', v_de, 'category', 'erp_financials', 'write_back', null,
    'Finance DE default — invoice/AR context only (read + dunning write-back), no CRM, no payroll/HR systems')
  on conflict (tenant_id, subject_kind, subject_id, resource_kind, coalesce(resource_id::text, resource_category)) do update set permission = excluded.permission, note = excluded.note;

  -- ── 1d. Extend the shared verification template's `actions` map
  -- with THREE new bindings (pure configuration — the template's ops/
  -- auth/base_url are untouched, exactly how 037 added log_checkin_
  -- note without touching anything else in the template).
  update adapter_templates
  set definition = jsonb_set(
    jsonb_set(
      jsonb_set(
        definition, '{actions,send_payment_reminder}',
        '{"method":"POST","path_template":"/comments","body_template":{"name":"Payment reminder — {account_name}","body":"{note}","email":"billing@example.com"}}'::jsonb
      ),
      '{actions,send_final_notice}',
      '{"method":"POST","path_template":"/comments","body_template":{"name":"FINAL NOTICE — {account_name}","body":"{note}","email":"billing@example.com"}}'::jsonb
    ),
    '{actions,flag_for_collections}',
    '{"method":"POST","path_template":"/comments","body_template":{"name":"Collections referral — {account_name}","body":"{note}","email":"billing@example.com"}}'::jsonb
  )
  where id = v_template_id
    and definition #> '{actions,send_payment_reminder}' is null;

  -- ── 1e. action_definitions — THREE rows, category=erp_financials.
  -- send_payment_reminder: non-destructive, low-risk — can eventually
  --   auto-execute once trust is earned (research: early-stage
  --   reminders are safe to automate once trust is earned).
  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'tenant', v_tenant, 'erp_financials', 'send_payment_reminder',
    'Send a payment reminder',
    'Sends a courtesy/gentle payment reminder for an overdue invoice — a plain, non-threatening nudge. Non-destructive: this is the kind of action that can auto-execute once this workspace has earned enough trust.',
    'template', v_template_id,
    '[{"name":"account_name","type":"string","required":true,"help":"The account the reminder is for"},{"name":"note","type":"string","required":true,"help":"The reminder text"}]'::jsonb,
    '{"destructive": false, "idempotent": false}'::jsonb,
    '{}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_action_reminder;
  if v_action_reminder is null then
    select id into v_action_reminder from action_definitions where scope='tenant' and tenant_id=v_tenant and category='erp_financials' and action_key='send_payment_reminder';
  end if;

  -- send_final_notice: destructive=true — a materially stronger,
  -- firmer action (research: escalation intensifies with delinquency
  -- and should sit at a higher bar). This platform's only lever for
  -- "a higher bar than the trust dial" is the destructive-always-gates
  -- floor (migration 035) — marking this destructive=true means it
  -- ALWAYS requires human approval, which is honestly a STRICTER bar
  -- than any earned trust level, satisfying the requirement without
  -- inventing an intermediate trust tier that doesn't exist elsewhere
  -- in this system (see the honest-limits note above this do-block).
  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'tenant', v_tenant, 'erp_financials', 'send_final_notice',
    'Send a final notice',
    'Sends a firmer "final notice" for a significantly overdue invoice. Always requires human approval before sending — a stronger action than a reminder, held to a higher bar regardless of trust level.',
    'template', v_template_id,
    '[{"name":"account_name","type":"string","required":true,"help":"The account the final notice is for"},{"name":"note","type":"string","required":true,"help":"The final notice text"}]'::jsonb,
    '{"destructive": true, "idempotent": false}'::jsonb,
    '{}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_action_final;
  if v_action_final is null then
    select id into v_action_final from action_definitions where scope='tenant' and tenant_id=v_tenant and category='erp_financials' and action_key='send_final_notice';
  end if;

  -- flag_for_collections: destructive=true — a credit-hold/collections-
  -- referral-flavored action. ALWAYS human-gated, no trust override,
  -- ever (research: credit holds, collections-agency referral, and
  -- legal-threat language must always require human approval — this
  -- is the platform's destructive-always-gates safety floor applied to
  -- money, the single most important proof in this build).
  insert into action_definitions (scope, tenant_id, category, action_key, label, description, provider, template_id, param_schema, risk, execution)
  values (
    'tenant', v_tenant, 'erp_financials', 'flag_for_collections',
    'Flag account for collections / credit hold',
    'Flags a severely delinquent account for a credit hold or collections-agency referral. Always requires human approval — this action can never auto-execute at any trust level, full stop.',
    'template', v_template_id,
    '[{"name":"account_name","type":"string","required":true,"help":"The account being flagged"},{"name":"note","type":"string","required":true,"help":"Why this account is being flagged"}]'::jsonb,
    '{"destructive": true, "idempotent": false}'::jsonb,
    '{}'::jsonb
  )
  on conflict (scope, tenant_id, category, action_key) do nothing
  returning id into v_action_collections;
  if v_action_collections is null then
    select id into v_action_collections from action_definitions where scope='tenant' and tenant_id=v_tenant and category='erp_financials' and action_key='flag_for_collections';
  end if;

  -- ── 1f. Earned trust — a fresh erp_financials-scoped action_execute
  -- policy at level 0 (baseline/gated). Without this row, decide_
  -- action_execution would fall back to the tenant-wide action_execute
  -- de_autonomy row (already enabled from Support's earned trust) and
  -- silently auto-execute the Finance DE's reminder action from day
  -- one — the EXACT generalization gap migration 037 found and fixed
  -- for decide_action_execution's category-scoped resolution. This row
  -- is what makes that fix actually matter for a second department.
  insert into trust_policies (tenant_id, de_id, action_category, source_category, baseline_level, current_level, criteria)
  values (
    v_tenant, v_de, 'action_execute', 'erp_financials', 0, 0,
    '{"window_days":30,"min_eval_pass_rate":0.9,"min_eval_samples":0,"min_human_approval_rate":0.9,"min_human_samples":3,"max_guardrail_blocks":0}'::jsonb
  )
  on conflict (tenant_id, action_category, coalesce(source_category, '')) do nothing;

  insert into de_autonomy (tenant_id, action_type, source_category, enabled, max_amount_cents, min_confidence)
  values (v_tenant, 'action_execute', 'erp_financials', false, null, null)
  on conflict (tenant_id, action_type, coalesce(source_category, '')) do nothing;

  -- ── 1g. Guardrails — extend the EXISTING blocked_phrase pattern to
  -- legal-threat-style language (research: any language resembling a
  -- legal threat must always require human approval, matching this
  -- platform's destructive-always-gates safety floor), and confirm/
  -- extend require_approval_over_cents at a Finance-appropriate
  -- account-value threshold ($25K ARR — high-value accounts should
  -- always route to a human, per the research grounding).
  insert into guardrail_rules (tenant_id, rule, rule_type, pattern, severity, active)
  select v_tenant,
    'No legal-threat language in Finance DE outputs — route to a human',
    'blocked_phrase',
    'legal action|lawsuit|sue you|attorney|court|legally liable|garnish|seize your assets',
    'blocking', true
  where not exists (
    select 1 from guardrail_rules where tenant_id = v_tenant and rule_type = 'blocked_phrase'
      and pattern = 'legal action|lawsuit|sue you|attorney|court|legally liable|garnish|seize your assets'
  );

  insert into guardrail_rules (tenant_id, rule, rule_type, threshold, severity, active)
  select v_tenant,
    'High-value accounts (ARR > $25,000) always route dunning actions to a human',
    'require_approval_over_cents', 25000 * 100,
    'blocking', true
  where not exists (
    select 1 from guardrail_rules where tenant_id = v_tenant and rule_type = 'require_approval_over_cents'
  );

  -- ── 1h. Playbooks — TWO real playbooks, existing step primitives
  -- only (check_account -> decision -> connector_action / checklist ->
  -- complete). The `decision` step branches on the account's arr_cents
  -- (already populated by check_account) against the SAME $25,000
  -- threshold as the guardrail above: high-value accounts skip the
  -- auto-capable connector_action entirely and go straight to a human
  -- checklist, regardless of what the trust dial would otherwise allow
  -- — "guardrail always wins" applied via the generic decision
  -- primitive, since decide_action_execution itself does not evaluate
  -- account value (see the honest-limits note above).
  --
  -- IMPORTANT DESIGN CORRECTION (found live during this build's own
  -- high-value-guardrail proof, fixed before shipping, not silently
  -- left broken): the playbook engine's `decision` step runs its
  -- then/else branch steps as ADDITIONAL inline steps and then
  -- unconditionally CONTINUES to the next TOP-LEVEL step regardless of
  -- which branch was taken — it does not skip/gate subsequent
  -- top-level steps. Putting connector_action at the TOP LEVEL after
  -- the decision (as an early draft of this migration did) would have
  -- made it run for EVERY account, high-value or not, silently
  -- defeating the guardrail. The correct, still-zero-new-primitive
  -- design is to put the send action INSIDE the decision's else_steps
  -- (the non-high-value path) so it only ever runs there; the
  -- then_steps (high-value path) contains only the human checklist and
  -- nothing that acts. (This also surfaced that BRANCH_ALLOWED had
  -- always listed connector_action as branch-legal at validation time
  -- without the branch executor actually implementing it — fixed in
  -- the same edge-function deploy as this migration, see the boundary
  -- doc for the full account.)
  --
  -- Stage 1 — dunning_payment_reminder: fires at 3+ days overdue.
  insert into playbook_definitions (tenant_id, key, name, description, version, status, trigger_type, de_id, steps)
  values (
    v_tenant, 'dunning_payment_reminder', 'Dunning — Payment Reminder',
    'Fires when an invoice has been overdue for a few days. High-value accounts (ARR over $25,000) always go straight to a human — the send action never runs for them. Otherwise sends a courtesy payment reminder via the generalized action layer — auto-sends only once this workspace has earned enough trust for erp_financials; otherwise a human approves it.',
    1, 'published', 'event', v_de,
    jsonb_build_array(
      jsonb_build_object('key','check_account','label','Check account','params','{}'::jsonb),
      jsonb_build_object(
        'key','decision','label','High-value account?',
        'params', jsonb_build_object('on','step:0.arr_cents','operator','greater_than','value', 25000 * 100),
        'then_steps', jsonb_build_array(
          jsonb_build_object('key','checklist','label','Human follow-up — high-value account','params',
            jsonb_build_object('items', jsonb_build_array(
              'This account is high-value (ARR over $25,000) — dunning always routes to a human here, regardless of trust level',
              'Review the overdue invoice and account relationship before contacting',
              'Decide on reminder tone / whether an account manager should reach out personally'
            )))
        ),
        'else_steps', jsonb_build_array(
          jsonb_build_object(
            'key','connector_action','label','Send payment reminder',
            'params', jsonb_build_object(
              'action_key','send_payment_reminder','action_category','erp_financials',
              'param_templates', jsonb_build_object(
                'account_name','{{account.name}}',
                'note','Payment reminder for {{account.name}} — invoice overdue. Sasha Reyes (Finance DE) sent this courtesy reminder as part of the standard dunning cadence.'
              )
            )
          )
        )
      ),
      jsonb_build_object('key','complete','label','Done','params','{}'::jsonb)
    )
  )
  on conflict (tenant_id, key) do update set status = 'published', steps = excluded.steps, de_id = excluded.de_id
  returning id into v_playbook_reminder;
  if v_playbook_reminder is null then
    select id into v_playbook_reminder from playbook_definitions where tenant_id = v_tenant and key = 'dunning_payment_reminder';
  end if;

  -- Keep the published snapshot (what startDefinitionRunServer
  -- actually executes) in sync with the definition on every re-run of
  -- this migration, not just the first — an insert-if-absent-only
  -- version row would silently keep executing a STALE snapshot after
  -- any future edit to this do-block's steps (exactly the gap this
  -- build's own high-value-guardrail fix hit live: the definition
  -- updated but the version snapshot did not, so the run kept
  -- executing the OLD 4-step shape until caught).
  insert into playbook_versions (definition_id, version, steps, published_by)
  select v_playbook_reminder, 1, (select steps from playbook_definitions where id = v_playbook_reminder), null
  where not exists (select 1 from playbook_versions where definition_id = v_playbook_reminder);
  update playbook_versions set steps = (select steps from playbook_definitions where id = v_playbook_reminder)
  where definition_id = v_playbook_reminder and version = 1;

  insert into de_playbook_charter (tenant_id, de_id, playbook_id, priority, active)
  values (v_tenant, v_de, v_playbook_reminder, 50, true)
  on conflict (de_id, playbook_id) do update set active = true, priority = 50;

  insert into playbook_event_rules (tenant_id, definition_id, event_key, params, cooldown_hours, active)
  select v_tenant, v_playbook_reminder, 'invoice_overdue', '{"overdue_days":3}'::jsonb, 24, true
  where not exists (
    select 1 from playbook_event_rules where tenant_id = v_tenant and definition_id = v_playbook_reminder and event_key = 'invoice_overdue'
  );

  -- Stage 2 — dunning_final_notice: fires at 14+ days overdue. Final
  -- notice is destructive=true at the action_definitions level, so
  -- connector_action here ALWAYS ends up human_gated_destructive no
  -- matter what the trust dial says — proven live in the verification
  -- section of this build, not just asserted here. The send is placed
  -- in else_steps for the SAME reason as stage 1 above (the decision
  -- primitive does not gate subsequent top-level steps) — here it is
  -- belt-and-suspenders, since destructive=true already gates it
  -- unconditionally regardless of which branch runs it from, but the
  -- structure stays consistent with stage 1 and keeps the human
  -- follow-up checklist attached to the actual send attempt.
  insert into playbook_definitions (tenant_id, key, name, description, version, status, trigger_type, de_id, steps)
  values (
    v_tenant, 'dunning_final_notice', 'Dunning — Final Notice',
    'Fires when an invoice has been overdue for a significant period. High-value accounts always go straight to a human — the prepared final notice never runs for them. Otherwise considers sending a firmer final notice — this action is always human-gated (destructive=true), regardless of trust level, since a final notice is a materially stronger step than a reminder.',
    1, 'published', 'event', v_de,
    jsonb_build_array(
      jsonb_build_object('key','check_account','label','Check account','params','{}'::jsonb),
      jsonb_build_object(
        'key','decision','label','High-value account?',
        'params', jsonb_build_object('on','step:0.arr_cents','operator','greater_than','value', 25000 * 100),
        'then_steps', jsonb_build_array(
          jsonb_build_object('key','checklist','label','Human follow-up — high-value account','params',
            jsonb_build_object('items', jsonb_build_array(
              'This account is high-value (ARR over $25,000) — final notice always routes to a human here',
              'Decide whether a final notice is the right next step or whether to escalate differently',
              'A human, not the DE, decides the wording and timing for a high-value relationship'
            )))
        ),
        'else_steps', jsonb_build_array(
          jsonb_build_object(
            'key','connector_action','label','Send final notice (always human-gated)',
            'params', jsonb_build_object(
              'action_key','send_final_notice','action_category','erp_financials',
              'param_templates', jsonb_build_object(
                'account_name','{{account.name}}',
                'note','Final notice considered for {{account.name}} — invoice significantly overdue. This always requires human approval before sending; Sasha Reyes (Finance DE) has prepared it for review.'
              )
            )
          ),
          jsonb_build_object('key','checklist','label','Human follow-up','params',
            jsonb_build_object('items', jsonb_build_array(
              'Review and approve (or decline) the prepared final notice',
              'Decide whether this account should be flagged for collections if it stays unpaid'
            )))
        )
      ),
      jsonb_build_object('key','complete','label','Done','params','{}'::jsonb)
    )
  )
  on conflict (tenant_id, key) do update set status = 'published', steps = excluded.steps, de_id = excluded.de_id
  returning id into v_playbook_final;
  if v_playbook_final is null then
    select id into v_playbook_final from playbook_definitions where tenant_id = v_tenant and key = 'dunning_final_notice';
  end if;

  insert into playbook_versions (definition_id, version, steps, published_by)
  select v_playbook_final, 1, (select steps from playbook_definitions where id = v_playbook_final), null
  where not exists (select 1 from playbook_versions where definition_id = v_playbook_final);
  update playbook_versions set steps = (select steps from playbook_definitions where id = v_playbook_final)
  where definition_id = v_playbook_final and version = 1;

  insert into de_playbook_charter (tenant_id, de_id, playbook_id, priority, active)
  values (v_tenant, v_de, v_playbook_final, 60, true)
  on conflict (de_id, playbook_id) do update set active = true, priority = 60;

  insert into playbook_event_rules (tenant_id, definition_id, event_key, params, cooldown_hours, active)
  select v_tenant, v_playbook_final, 'invoice_overdue', '{"overdue_days":14}'::jsonb, 24, true
  where not exists (
    select 1 from playbook_event_rules where tenant_id = v_tenant and definition_id = v_playbook_final and event_key = 'invoice_overdue'
  );

  -- Best-effort audit (migration/seed context has no auth.uid() session
  -- — the internal, membership-check-free writer, same pattern 021/
  -- 029/037 already use for this exact situation).
  perform append_audit_event_internal(
    v_tenant, 'DreamTeam', 'system',
    'Finance DE ("Sasha Reyes") stood up — erp_financials access (read + dunning write-back), two dunning playbook charters (payment reminder / final notice), 3 action_definitions registered (send_payment_reminder non-destructive, send_final_notice + flag_for_collections destructive/always-gated), action_execute trust started at level 0 (gated) for erp_financials, legal-threat-language guardrail added, $25,000 high-value-account guardrail confirmed.',
    'config_change',
    jsonb_build_object('kind', 'finance_de_provisioned', 'de_id', v_de,
      'playbook_reminder_id', v_playbook_reminder, 'playbook_final_id', v_playbook_final,
      'action_definition_ids', jsonb_build_array(v_action_reminder, v_action_final, v_action_collections))
  );
end $$;

-- ============================================================
-- 2. STALENESS WATCHDOG (migration 042) — target_kind for overdue
-- invoices sitting unattended. HONEST NOTE (matching 042's own stated
-- limit): renewal_invoices is a genuinely new TABLE SHAPE (status +
-- due_date, not status/updated_at like onboarding_projects nor
-- pending/created_at like human_tasks) — this needs ONE small new
-- lookup branch in check_staleness, exactly the cost 042 said a new
-- SHAPE (not just a new policy row) would need. The tier/cooldown/
-- task-creation logic itself is 100% reused via the SAME shared
-- stale_upsert_escalation helper — no duplicated business logic.
-- ============================================================
insert into staleness_policies (tenant_id, target_kind, warning_after, breach_after, enabled)
select t.id, 'overdue_invoice_unattended', interval '7 days', interval '21 days', true
from tenants t
on conflict (tenant_id, target_kind) do nothing;

create or replace function check_staleness(p_tenant_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy   record;
  v_proj     record;
  v_task     record;
  v_inv      record;
  v_open     record;
  v_warned   integer := 0;
  v_breached integer := 0;
  v_resolved integer := 0;
  v_acct     text;
begin
  -- ── Evaluate every enabled policy, explicit tenant filter always ──
  for v_policy in
    select * from staleness_policies sp
    where sp.enabled
      and (p_tenant_id is null or sp.tenant_id = p_tenant_id)
  loop

    if v_policy.target_kind = 'onboarding_project' then
      for v_proj in
        select op.id, op.name, op.updated_at, op.account_id
        from onboarding_projects op
        where op.tenant_id = v_policy.tenant_id
          and op.status = 'active'
      loop
        select name into v_acct from customer_accounts
          where id = v_proj.account_id and tenant_id = v_policy.tenant_id;

        if now() - v_proj.updated_at >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'onboarding_project', v_proj.id, 'breach',
            format('Onboarding stalled — %s', v_proj.name),
            format('This onboarding project for %s hasn''t been touched in %s (breach threshold: %s).',
                   coalesce(v_acct, v_proj.name), stale_humanize_interval(now() - v_proj.updated_at),
                   stale_humanize_interval(v_policy.breach_after)),
            'onboarding_projects', v_proj.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif now() - v_proj.updated_at >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'onboarding_project', v_proj.id, 'warning',
            format('Onboarding going quiet — %s', v_proj.name),
            format('This onboarding project for %s hasn''t been touched in %s (warning threshold: %s).',
                   coalesce(v_acct, v_proj.name), stale_humanize_interval(now() - v_proj.updated_at),
                   stale_humanize_interval(v_policy.warning_after)),
            'onboarding_projects', v_proj.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'onboarding_project'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from onboarding_projects op
          where op.id = v_open.target_id and op.tenant_id = v_policy.tenant_id
            and op.status = 'active'
            and now() - op.updated_at >= v_policy.warning_after
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    elsif v_policy.target_kind = 'pending_review_task' then
      for v_task in
        select ht.id, ht.title, ht.created_at, ht.type
        from human_tasks ht
        where ht.tenant_id = v_policy.tenant_id
          and ht.status = 'pending'
          and ht.type in ('inquiry_review', 'action_approval', 'checklist', 'review_gate', 'approval_gate')
      loop
        if now() - v_task.created_at >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'pending_review_task', v_task.id, 'breach',
            format('Review overdue — %s', v_task.title),
            format('This %s has been waiting %s for a human decision (breach threshold: %s).',
                   replace(v_task.type, '_', ' '), stale_humanize_interval(now() - v_task.created_at),
                   stale_humanize_interval(v_policy.breach_after)),
            'human_tasks', v_task.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif now() - v_task.created_at >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'pending_review_task', v_task.id, 'warning',
            format('Review waiting — %s', v_task.title),
            format('This %s has been waiting %s for a human decision (warning threshold: %s).',
                   replace(v_task.type, '_', ' '), stale_humanize_interval(now() - v_task.created_at),
                   stale_humanize_interval(v_policy.warning_after)),
            'human_tasks', v_task.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'pending_review_task'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from human_tasks ht
          where ht.id = v_open.target_id and ht.tenant_id = v_policy.tenant_id
            and ht.status = 'pending'
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    elsif v_policy.target_kind = 'overdue_invoice_unattended' then
      -- ── NEW SHAPE: renewal_invoices, status/due_date. "Unattended"
      -- means still sitting in 'sent' or 'awaiting_approval' status
      -- past the invoice's own due_date by the policy's threshold —
      -- the clock is due_date, not updated_at/created_at, since an
      -- overdue invoice's staleness clock starts at its due date, not
      -- whenever the row happened to last change. Cadence_stage
      -- advancing (a reminder/final-notice actually going out) is
      -- itself a "touch," so the RESOLVE check below only clears an
      -- escalation once the invoice is paid/cancelled — an invoice
      -- that has been reminded but is still unpaid stays flagged,
      -- honestly, since the underlying problem (money owed) has not
      -- actually been resolved by sending a reminder alone.
      for v_inv in
        select ri.id, ri.account_id, ri.amount_cents, ri.due_date, ca.name as account_name
        from renewal_invoices ri
        join customer_accounts ca on ca.id = ri.account_id and ca.tenant_id = v_policy.tenant_id
        where ri.tenant_id = v_policy.tenant_id
          and ri.status in ('sent', 'awaiting_approval')
          and ri.due_date is not null
      loop
        if (current_date - v_inv.due_date) * interval '1 day' >= v_policy.breach_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'overdue_invoice_unattended', v_inv.id, 'breach',
            format('Invoice seriously overdue — %s', v_inv.account_name),
            format('Invoice for %s (%s cents) has been overdue since %s — %s past due (breach threshold: %s).',
                   v_inv.account_name, v_inv.amount_cents, v_inv.due_date,
                   stale_humanize_interval((current_date - v_inv.due_date) * interval '1 day'),
                   stale_humanize_interval(v_policy.breach_after)),
            'renewal_invoices', v_inv.id
          ) is not null then v_breached := v_breached + 1; end if;
        elsif (current_date - v_inv.due_date) * interval '1 day' >= v_policy.warning_after then
          if stale_upsert_escalation(
            v_policy.tenant_id, 'overdue_invoice_unattended', v_inv.id, 'warning',
            format('Invoice overdue — %s', v_inv.account_name),
            format('Invoice for %s (%s cents) has been overdue since %s — %s past due (warning threshold: %s).',
                   v_inv.account_name, v_inv.amount_cents, v_inv.due_date,
                   stale_humanize_interval((current_date - v_inv.due_date) * interval '1 day'),
                   stale_humanize_interval(v_policy.warning_after)),
            'renewal_invoices', v_inv.id
          ) is not null then v_warned := v_warned + 1; end if;
        end if;
      end loop;

      for v_open in
        select se.id, se.target_id
        from staleness_escalations se
        where se.tenant_id = v_policy.tenant_id
          and se.target_kind = 'overdue_invoice_unattended'
          and se.resolved_at is null
      loop
        if not exists (
          select 1 from renewal_invoices ri
          where ri.id = v_open.target_id and ri.tenant_id = v_policy.tenant_id
            and ri.status in ('sent', 'awaiting_approval')
        ) then
          update staleness_escalations set resolved_at = now() where id = v_open.id;
          v_resolved := v_resolved + 1;
        end if;
      end loop;

    end if;
    -- A future target_kind reusing one of the three shapes above needs
    -- ONLY a new staleness_policies row. A genuinely new table shape
    -- (as overdue_invoice_unattended itself was, relative to 042's
    -- original two) needs one new small lookup branch, same cost as
    -- any new table integration anywhere — stated honestly, matching
    -- 042's own documented limit, not silently violated here.
  end loop;

  return jsonb_build_object('warned', v_warned, 'breached', v_breached, 'resolved', v_resolved);
end;
$$;

-- Grant hygiene: check_staleness's signature is unchanged from 042
-- (still check_staleness(uuid)) — re-issuing the SAME revoke/grant
-- 042 already established (idempotent, not a new grant to verify from
-- scratch, but re-run explicitly since this migration REPLACEs the
-- function body).
revoke all on function check_staleness(uuid) from public, anon, authenticated;
grant execute on function check_staleness(uuid) to service_role;

-- ============================================================
-- 3. FIX REGRESSION (found live while standing up this DE, same class
-- of issue 037 found and fixed twice): migration 042's REPLACE of
-- invoke_playbook_dispatch() (to add the check_staleness piggyback)
-- silently DROPPED migration 037's restored nightly health-recompute
-- pre-step AGAIN — the live function body (verified directly against
-- pg_proc before writing this fix, not assumed from a prior migration
-- file) has no health-recompute loop at all. Restored below, byte-
-- faithful to 037's restoration, composed with 042's staleness
-- piggyback — all three (health recompute, poll_de_work_sources,
-- check_staleness) now run on every 5-min tick again.
-- ============================================================
create or replace function invoke_playbook_dispatch()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret  text;
  v_req_id  bigint;
  v_req_id2 bigint;
  v_t       record;
  v_health  integer := 0;
  v_stale   jsonb;
begin
  -- ── (0) nightly health recompute, per tenant with accounts (021,
  -- restored by 037, re-restored here after 042's REPLACE dropped it
  -- again) ──
  for v_t in
    select distinct ca.tenant_id
    from customer_accounts ca
    left join health_score_config c on c.tenant_id = ca.tenant_id
    where c.last_computed_at is null or c.last_computed_at < now() - interval '24 hours'
  loop
    perform compute_tenant_health_service(v_t.tenant_id);
    v_health := v_health + 1;
  end loop;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return format('health:%s no_secret', v_health);
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/playbook-execute',
    body    := '{"action":"dispatch"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id;

  -- Piggyback: the GENERALIZED proactive trigger, any category, on
  -- the SAME 5-minute tick (036). Independent request; a failure here
  -- never blocks or is blocked by the playbook dispatch above.
  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/specialist-consult',
    body    := '{"action":"poll_de_work_sources"}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dispatch-secret', v_secret
    ),
    timeout_milliseconds := 30000
  ) into v_req_id2;

  -- Piggyback #2: the generalized staleness watchdog (042). Pure SQL,
  -- no HTTP hop needed. Wrapped so a bug here can never take down the
  -- two dispatch calls above (both already queued via pg_net).
  begin
    v_stale := check_staleness();
  exception when others then
    v_stale := jsonb_build_object('error', sqlerrm);
  end;

  return format('health:%s queued:%s,%s staleness:%s', v_health, v_req_id, v_req_id2, v_stale::text);
end;
$$;

-- Grant hygiene: re-verified live via information_schema.routine_
-- privileges after this migration's own REPLACE and found the EXACT
-- migration-040 gotcha again — invoke_playbook_dispatch had EXECUTE
-- still granted to anon AND authenticated (neither 037 nor 042 had
-- ever revoked those explicitly, only `from public`, so the named-role
-- grants Postgres attaches by default at function-creation time had
-- silently persisted through two prior REPLACEs). Fixed here: revoke
-- from public, anon, AND authenticated explicitly, then grant back to
-- service_role/postgres only. This function has no direct frontend
-- caller (pg_cron only) and takes no parameters, so there is no
-- legitimate reason for anon/authenticated to ever hold EXECUTE on it.
revoke all on function invoke_playbook_dispatch() from public, anon, authenticated;
grant execute on function invoke_playbook_dispatch() to service_role, postgres;

-- ============================================================
-- 4. FIX GENUINE PRE-EXISTING BUG (found live while proving this
-- build's trust-ladder promotion path, per the standing rule: "if you
-- find yourself needing a bespoke workaround, fix the primitive
-- instead" — this is a restoration/completion, not new business
-- logic): trust_apply_level (migration 025) was never updated when
-- migration 036 added source_category to de_autonomy and widened its
-- unique index from (tenant_id, action_type) to (tenant_id,
-- action_type, coalesce(source_category, '')). trust_apply_level's
-- own `on conflict (tenant_id, action_type)` no longer matches ANY
-- real constraint on the table, so calling it for a category-scoped
-- action_category (the exact case this build needed, to prove the
-- earned-trust promotion machinery on erp_financials) fails outright
-- with "no unique or exclusion constraint matching the ON CONFLICT
-- specification." Worse, this ALSO silently affected apply_trust_
-- promotion (the human-approved promotion path) for the Account DE's
-- own crm-scoped policy since migration 037 shipped — nobody had
-- exercised a REAL promotion approval on a category-scoped policy end
-- to end until this build tried to. Fixed by threading an explicit
-- p_source_category parameter (nullable, backward compatible — a null
-- behaves exactly as before, tenant-wide) through both functions and
-- correcting the ON CONFLICT target to match the real unique index.
-- ============================================================
create or replace function trust_apply_level(p_tenant_id uuid, p_category text, p_level integer, p_actor uuid, p_source_category text default null)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_s jsonb := trust_level_settings(p_category, p_level);
begin
  insert into de_autonomy (tenant_id, action_type, source_category, enabled, max_amount_cents, min_confidence, updated_by)
  values (
    p_tenant_id, p_category, p_source_category,
    (v_s->>'enabled')::boolean,
    nullif(v_s->>'max_amount_cents', '')::bigint,
    nullif(v_s->>'min_confidence', '')::integer,
    p_actor
  )
  on conflict (tenant_id, action_type, coalesce(source_category, '')) do update set
    enabled          = excluded.enabled,
    max_amount_cents = excluded.max_amount_cents,
    min_confidence   = excluded.min_confidence,
    updated_by       = excluded.updated_by,
    updated_at       = now();
end;
$$;
revoke all on function trust_apply_level(uuid, text, integer, uuid, text) from public, anon, authenticated;
-- internal helper — not granted to authenticated, matching 025's original treatment.
-- The old 4-arg signature is DROPPED (not left dangling) since every
-- call site (apply_trust_promotion below) moves to the 5-arg form —
-- leaving both would let a stale caller silently hit the broken one.
drop function if exists trust_apply_level(uuid, text, integer, uuid);

-- apply_trust_promotion: thread v_policy.source_category through to
-- trust_apply_level (the ONE line that was missing) — everything else
-- (self-approval block, stale-evidence re-check, audit trail) is
-- byte-identical to migration 025's original.
create or replace function apply_trust_promotion(p_task_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_policy   trust_policies;
  v_evidence jsonb;
  v_new      integer;
  v_label    text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected';
  end if;

  select * into v_policy from trust_policies where pending_task_id = p_task_id;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'no_pending_policy');
  end if;

  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = v_policy.tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  v_label := replace(v_policy.action_category, '_', ' ');

  if p_decision = 'rejected' then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'You', 'human',
      format('Trust promotion rejected — %s stays at level %s', v_label, v_policy.current_level),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_rejected', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'level', v_policy.current_level,
        'task_id', p_task_id, 'decided_by', auth.uid())
    );
    return jsonb_build_object('applied', false, 'reason', 'rejected');
  end if;

  -- Self-approval block: the requester cannot approve their own promotion.
  if auth.uid() is not null and v_policy.requested_by is not null and auth.uid() = v_policy.requested_by then
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion blocked — requester cannot approve their own request (%s)', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_blocked_self_approval', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id, 'user_id', auth.uid())
    );
    raise exception 'the requester cannot approve their own promotion — a different teammate must approve';
  end if;

  -- Stale-check: evidence could have regressed since the request.
  v_evidence := trust_evidence_for(v_policy);
  if not coalesce((v_evidence->>'eligible')::boolean, false) then
    update trust_policies
    set pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
    where id = v_policy.id;
    perform append_audit_event(
      v_policy.tenant_id, 'Trust engine', 'system',
      format('Trust promotion rejected as stale — %s evidence regressed since the request', v_label),
      'config_change',
      jsonb_build_object('kind', 'trust_promotion_stale', 'policy_id', v_policy.id,
        'action_category', v_policy.action_category, 'task_id', p_task_id,
        'evidence_at_request', v_policy.pending_evidence, 'evidence_at_apply', v_evidence)
    );
    raise exception 'evidence regressed since the request — promotion rejected as stale';
  end if;

  v_new := least(v_policy.current_level + 1, 3);
  perform trust_apply_level(v_policy.tenant_id, v_policy.action_category, v_new, auth.uid(), v_policy.source_category);

  update trust_policies
  set current_level = v_new,
      pending_task_id = null, pending_evidence = null, requested_by = null, requested_at = null
  where id = v_policy.id;

  perform append_audit_event(
    v_policy.tenant_id, 'You', 'human',
    format('Trust promoted — %s level %s → %s (evidence re-verified at apply time; still capped by guardrails)',
      v_label, v_policy.current_level, v_new),
    'config_change',
    jsonb_build_object('kind', 'trust_promoted', 'policy_id', v_policy.id,
      'action_category', v_policy.action_category, 'from_level', v_policy.current_level,
      'to_level', v_new, 'task_id', p_task_id, 'approved_by', auth.uid(),
      'requested_by', v_policy.requested_by, 'evidence', v_evidence,
      'dial_settings', trust_level_settings(v_policy.action_category, v_new),
      'composition', 'autonomy_narrows_within_guardrails')
  );

  return jsonb_build_object('applied', true, 'new_level', v_new);
end;
$$;
revoke all on function apply_trust_promotion(uuid, text) from public, anon, authenticated;
grant execute on function apply_trust_promotion(uuid, text) to authenticated, service_role;
