-- 690 — the fitness loop's claim referenced a column that does not exist (G-E).
--
-- Every invocation of claim_amendment_for_fitness since mig 312 has thrown
-- 42703: `RETURNING id INTO v_id` — but amendment_metrics' primary key is
-- METRIC_ID (mig 20260720). The driver read the claim through .rpc(), which
-- RESOLVES on a Postgres error (this repo's oldest .rpc() lesson), saw null,
-- and reported `skipped: already_claimed` — misdiagnosing its own crash as
-- contention, every 30 minutes, with a measurable amendment waiting. Proven
-- live before this fix: the bare call raises 42703; amendment_metrics has
-- zero rows in history; cron run 853 ticks green.
--
-- Two lessons re-learned, now enforced here:
--   * .rpc() error members must be READ (the driver is fixed alongside this
--     to fail LOUD on a claim error instead of inventing a benign reason);
--   * a claim function's own failure mode must never be indistinguishable
--     from "someone else has it".
--
-- Also lands the still-missing half of G-E: revert_entity_amendment — the
-- fitness loop may now recommend undoing a change it measured as a
-- regression, and until now there was no undo.

-- ── 1. The one-word fix, with its function ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_amendment_for_fitness(
  p_tenant_id uuid, p_amendment_id uuid, p_entity_kind text, p_entity_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO amendment_metrics (tenant_id, amendment_id, entity_kind, entity_id,
      before_metrics, replay_score_before, replay_score_after, adopted_at)
  VALUES (p_tenant_id, p_amendment_id, p_entity_kind, p_entity_id,
      '{}'::jsonb, null, null, now())
  ON CONFLICT (amendment_id) DO NOTHING
  RETURNING metric_id INTO v_id;
  RETURN jsonb_build_object('claimed', v_id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION public.claim_amendment_for_fitness(uuid, uuid, text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_amendment_for_fitness(uuid, uuid, text, uuid) TO service_role;

-- ── 2. The undo the loop was missing ───────────────────────────────────────
-- Status gains 'reverted'; NOT VALID is unnecessary (no existing row violates).
ALTER TABLE workforce_entity_amendments DROP CONSTRAINT IF EXISTS workforce_entity_amendments_status_check;
ALTER TABLE workforce_entity_amendments ADD CONSTRAINT workforce_entity_amendments_status_check
  CHECK (status in ('draft','review_pending','approved','rejected','applied','reverted'));

create or replace function public.revert_entity_amendment(p_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_am workforce_entity_amendments; v_cfg jsonb; v_who text;
begin
  select * into v_am from workforce_entity_amendments where id = p_id;
  if not found then raise exception 'amendment not found'; end if;
  -- Caller must be a member of the amendment's tenant with admin rights,
  -- unless this is the service runtime acting on a measured regression.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_am.tenant_id <> auth_tenant_id() then raise exception 'amendment not found'; end if;
    if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
      raise exception 'only a workspace owner or admin may revert an amendment';
    end if;
  end if;
  if v_am.status <> 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'status is ' || v_am.status || ', only applied amendments revert');
  end if;

  v_cfg := v_am.current_config;   -- the pre-amendment truth, stored since day one
  if v_am.entity_kind = 'de' then
    update digital_employees set
      persona_name      = coalesce(v_cfg->>'persona_name', persona_name),
      description       = coalesce(v_cfg->>'description', description),
      purpose_statement = coalesce(v_cfg->>'purpose_statement', purpose_statement)
    where id = v_am.entity_id and tenant_id = v_am.tenant_id;
  else
    update specialist_profiles set charter = coalesce(v_cfg->>'charter', charter)
      where id = v_am.entity_id and tenant_id = v_am.tenant_id;
  end if;

  update workforce_entity_amendments set status = 'reverted' where id = p_id;
  select coalesce(d.persona_name, d.name, 'entity') into v_who
    from digital_employees d where d.id = v_am.entity_id;
  begin
    perform append_audit_event(v_am.tenant_id, 'Practice Engine', 'de',
      format('%s amendment REVERTED — prior configuration restored for %s', v_am.entity_kind, coalesce(v_who, 'entity')),
      'config_change', jsonb_build_object('kind','entity_amendment_reverted','amendment_id',p_id,
        'entity_kind',v_am.entity_kind,'entity_id',v_am.entity_id,'origin','production'));
  exception when others then null; end;
  return jsonb_build_object('ok', true, 'entity_id', v_am.entity_id, 'restored_from', 'current_config');
end; $function$;
revoke all on function public.revert_entity_amendment(uuid) from public, anon;
grant execute on function public.revert_entity_amendment(uuid) to authenticated, service_role;

-- ── 3. Prove it, in this transaction ───────────────────────────────────────
do $$
declare
  v_t uuid; v_amend uuid := gen_random_uuid(); v_entity uuid := gen_random_uuid();
  v_claim jsonb; v_reclaim jsonb; v_n bigint;
begin
  select id into v_t from tenants order by created_at limit 1;

  -- Synthetic amendment row (probe — deleted below, pattern of mig 608).
  insert into workforce_entity_amendments (id, tenant_id, entity_kind, entity_id,
      trigger_reason, current_config, proposed_config, status)
  values (v_amend, v_t, 'de', v_entity, '690 probe', '{}'::jsonb, '{}'::jsonb, 'applied');

  -- The claim now CLAIMS: first call wins and leaves the fail-closed row…
  v_claim := claim_amendment_for_fitness(v_t, v_amend, 'de', v_entity);
  if (v_claim->>'claimed') <> 'true' then
    raise exception '690: first claim did not claim: %', v_claim;
  end if;
  select count(*) into v_n from amendment_metrics where amendment_id = v_amend;
  if v_n <> 1 then raise exception '690: claim left % rows, expected the one fail-closed record', v_n; end if;

  -- …and the second call correctly loses (real contention, not a masked error).
  v_reclaim := claim_amendment_for_fitness(v_t, v_amend, 'de', v_entity);
  if (v_reclaim->>'claimed') <> 'false' then
    raise exception '690: second claim should lose: %', v_reclaim;
  end if;

  -- Revert is executable and honest about state: a non-applied amendment refuses.
  update workforce_entity_amendments set status = 'reverted' where id = v_amend;
  if (revert_entity_amendment(v_amend)->>'ok') <> 'false' then
    raise exception '690: revert accepted a non-applied amendment';
  end if;

  -- Probe rows out (metrics row first — no FK, but leave nothing behind).
  delete from amendment_metrics where amendment_id = v_amend;
  delete from workforce_entity_amendments where id = v_amend;

  -- The status CHECK carries 'reverted'.
  perform 1 from pg_constraint
   where conname = 'workforce_entity_amendments_status_check'
     and pg_get_constraintdef(oid) ilike '%reverted%';
  if not found then raise exception '690: status CHECK does not include reverted'; end if;
end $$;
