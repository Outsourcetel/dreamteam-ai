-- ═══════════════════════════════════════════════════════════════
-- 180 — Consolidation-pass fixes (adversarial review of Frontier-20)
--
-- begin_objective_wake claimed to be burst-safe, but its UPDATE never
-- re-checked the alarm: two overlapping de-work runs that both read
-- wake_due_objectives before either claimed would BOTH succeed, review
-- the same objective twice, and double-enqueue follow-ups under
-- different wake numbers. Adding `next_wake_at <= now()` to the WHERE
-- makes it a real claim: the first caller advances the alarm, the
-- second finds no row and raises — which the de-work wake loop already
-- treats as "skip this objective".
-- ═══════════════════════════════════════════════════════════════

-- verify_de_delegation_token: a valid token presented against the WRONG
-- agent used to consume a use before the caller's DE-binding check 403'd —
-- letting anyone holding the token grief its max_uses budget by replaying
-- it at other agents. The expected DE now participates in the atomic claim
-- WHERE, so a mismatch consumes nothing. (Drop first: adding a defaulted
-- parameter would otherwise create an ambiguous overload.)
drop function if exists public.verify_de_delegation_token(text, text);
create or replace function public.verify_de_delegation_token(
  p_raw text, p_required_scope text, p_expected_de uuid default null
) returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_row de_delegation_tokens;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'verify_de_delegation_token is service-role only';
  end if;
  update de_delegation_tokens
     set used_count = used_count + 1
   where token_hash = encode(digest(coalesce(p_raw, ''), 'sha256'), 'hex')
     and revoked_at is null
     and expires_at > now()
     and used_count < max_uses
     and p_required_scope = any(scopes)
     and (p_expected_de is null or de_id = p_expected_de)
   returning * into v_row;
  if v_row.id is null then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object('valid', true, 'tenant_id', v_row.tenant_id, 'de_id', v_row.de_id,
                            'scopes', v_row.scopes, 'token_id', v_row.id,
                            'originating_kind', v_row.originating_kind, 'originating_ref', v_row.originating_ref);
end;
$function$;
revoke all on function public.verify_de_delegation_token(text, text, uuid) from public, anon, authenticated;
grant execute on function public.verify_de_delegation_token(text, text, uuid) to service_role;

create or replace function public.begin_objective_wake(p_objective_id uuid)
returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare v_count integer;
begin
  update de_objectives
     set wake_count = wake_count + 1,
         next_wake_at = case when cadence_minutes is not null
                             then now() + make_interval(mins => cadence_minutes)
                             else now() + interval '60 minutes' end,
         updated_at = now()
   where id = p_objective_id and status in ('open', 'in_progress')
     and next_wake_at is not null and next_wake_at <= now()   -- the actual claim
   returning wake_count into v_count;
  if v_count is null then raise exception 'objective not wakeable (already claimed, disarmed, or closed)'; end if;
  return v_count;
end;
$function$;
