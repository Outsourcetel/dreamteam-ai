-- 668: add 'confidence' to conversation_checks.kind.
--
-- Caught implementing the writer, one migration after 667 shipped: LOW
-- CONFIDENCE is the commonest reason a conversation escalates, and the CHECK
-- had no honest kind for it — the choices were to file it under
-- 'escalation_rule' (a lie: no rule fired) or drop it (hiding the main
-- reason the human is looking at the panel). 667 is applied and the ledger
-- keys on filename, so it gets a follow-up, never a rewrite.

do $$
begin
  if to_regclass('public.conversation_checks') is null then
    raise exception 'conversation_checks does not exist — apply 667 first';
  end if;
  if exists (
    select 1 from information_schema.check_constraints cc
    join information_schema.constraint_column_usage u using (constraint_schema, constraint_name)
    where u.table_name = 'conversation_checks' and cc.check_clause like '%confidence%'
  ) then
    raise exception 'confidence kind already present — 668 already applied';
  end if;
end $$;

alter table public.conversation_checks drop constraint conversation_checks_kind_check;
alter table public.conversation_checks add constraint conversation_checks_kind_check
  check (kind in ('knowledge','identity','guardrail','escalation_rule','confidence','connector'));

do $$
begin
  if not exists (
    select 1 from information_schema.check_constraints cc
    join information_schema.constraint_column_usage u using (constraint_schema, constraint_name)
    where u.table_name = 'conversation_checks' and cc.check_clause like '%confidence%'
  ) then
    raise exception 'confidence kind did not land';
  end if;
end $$;
