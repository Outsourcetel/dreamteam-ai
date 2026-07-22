-- ============================================================================
-- 262 — GENERIC ESCALATION CONDITIONS ENGINE (founder: escalation was support-
-- shaped; make it role-customizable, not a fixed frustration+keyword cage)
--
-- Before: escalation = frustration_threshold (a SUPPORT concept) + keyword
-- topics + keyword custom_rules. A finance DE could not express "escalate if a
-- payment exceeds $10k" or "escalate on an anomaly" — no numeric/field
-- condition existed, and the enforcement only understood keyword `.when`.
--
-- After: a composable condition model over an EXTENSIBLE SIGNAL CATALOG.
--   condition = { signal, op, value }
--   rule      = { id, name, enabled, match: 'all'|'any', conditions: [...] }
-- Support composes text/sentiment/confidence conditions; finance composes
-- amount/anomaly conditions; a new vertical adds a signal row and it appears
-- in the builder — zero code. custom_rules is empty everywhere today, so the
-- reshape carries no migration risk; legacy frustration/topics still honored.
-- ============================================================================

-- ── The signal catalog: what an escalation condition can test. Global seeds
--    (tenant_id null) + per-tenant custom signals. value_type drives the
--    operators the UI offers; applies_to says which contexts it's evaluable in.
create table if not exists public.escalation_signals (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references public.tenants(id) on delete cascade,   -- null = global
  key         text not null,
  label       text not null,
  value_type  text not null check (value_type in ('number', 'text', 'boolean')),
  applies_to  text[] not null default '{answer}',   -- 'answer' | 'action' | 'any'
  help        text,
  sort_order  int not null default 100,
  created_at  timestamptz not null default now(),
  unique (tenant_id, key)
);
alter table public.escalation_signals enable row level security;
drop policy if exists escalation_signals_read on public.escalation_signals;
create policy escalation_signals_read on public.escalation_signals for select using (
  tenant_id is null
  or tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

insert into public.escalation_signals (tenant_id, key, label, value_type, applies_to, help, sort_order) values
  (null, 'confidence',   'Answer confidence',   'number',  '{answer}',        'How confident the employee is in its answer (0–100).', 10),
  (null, 'message_text', 'Customer message',    'text',    '{answer}',        'The text of the incoming customer message.', 20),
  (null, 'sentiment',    'Customer frustration','number',  '{answer}',        'Detected frustration / negative sentiment (0–100).', 30),
  (null, 'language',     'Detected language',   'text',    '{answer}',        'The language the customer wrote in.', 40),
  (null, 'amount',       'Transaction amount',  'number',  '{action}',        'The monetary amount of an action, in dollars.', 50),
  (null, 'action',       'Action being taken',  'text',    '{action}',        'What the employee is about to do (the action label).', 60),
  (null, 'destructive',  'Irreversible action', 'boolean', '{action}',        'Whether the action cannot be undone.', 70)
on conflict (tenant_id, key) do nothing;

create or replace function public.get_escalation_signals()
returns setof public.escalation_signals language sql stable security definer set search_path to 'public' as $$
  select * from public.escalation_signals
   where tenant_id is null or tenant_id = public.auth_tenant_id()
   order by sort_order, label;
$$;
revoke all on function public.get_escalation_signals() from public, anon;
grant execute on function public.get_escalation_signals() to authenticated, service_role;

-- ── The resolver: the full ruleset for a DE = its own rules + tenant defaults,
--    plus the legacy frustration/topics (still honored by the evaluator).
create or replace function public.get_de_escalation_rules(p_de_id uuid)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $function$
declare v_tenant uuid; v_de_rules jsonb; v_tenant_rules jsonb; v_frust int; v_topics text[];
begin
  v_tenant := public.auth_tenant_id();
  if v_tenant is null then return jsonb_build_object('ok', false, 'error', 'not_permitted'); end if;
  if not exists (select 1 from digital_employees where id = p_de_id and tenant_id = v_tenant) then
    return jsonb_build_object('ok', false, 'error', 'de_not_found');
  end if;

  select coalesce(custom_rules, '[]'::jsonb) into v_de_rules
    from de_escalation_rules where tenant_id = v_tenant and de_id = p_de_id;
  select coalesce(custom_rules, '[]'::jsonb) into v_tenant_rules
    from de_escalation_rules where tenant_id = v_tenant and de_id is null;

  select frustration_threshold, always_escalate_topics into v_frust, v_topics
    from resolve_de_escalation(v_tenant, p_de_id);

  return jsonb_build_object(
    'ok', true,
    'frustration_threshold', v_frust,
    'always_escalate_topics', to_jsonb(coalesce(v_topics, '{}')),
    'de_rules', coalesce(v_de_rules, '[]'::jsonb),
    'tenant_rules', coalesce(v_tenant_rules, '[]'::jsonb)
  );
end $function$;
revoke all on function public.get_de_escalation_rules(uuid) from public, anon;
grant execute on function public.get_de_escalation_rules(uuid) to authenticated, service_role;

-- NOTE: saving rules reuses the existing set_de_custom_escalation_rules
-- (per-DE upsert of custom_rules, gated by auth_has_tenant_role) — the stored
-- array's SHAPE is the caller's choice, so no new setter is needed. The UI now
-- writes the generic { name, enabled, match, conditions:[{signal,op,value}] }
-- shape into the same column; legacy { when } rows still evaluate.

NOTIFY pgrst, 'reload schema';
