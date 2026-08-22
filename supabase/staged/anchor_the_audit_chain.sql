-- ============================================================================
-- The audit chain learns to notice tail truncation.
--
-- ⚠ STAGED, NOT NUMBERED. Written without production access;
-- scripts/migration-next.mjs claims its number ON production ("NO PRODUCTION,
-- NO CLAIM"). To land it:
--
--     npm run migrate:next -- anchor_the_audit_chain
--     # move this body into the file that prints, commit, push, merge to main
--     node scripts/db-query.mjs --file supabase/migrations/<NNN>_<slug>.sql
--
-- ── THE GAP ────────────────────────────────────────────────────────────────
-- verify_audit_chain_internal runs three checks and they are well built:
--   CONTENT      every row's hash must equal the digest of its own contents
--                → catches an EDIT
--   GENESIS      exactly one row with an empty prev_hash
--                → catches a GRAFT
--   REACHABILITY a recursive walk from genesis must reach every row
--                → catches a MID-CHAIN DELETION
--
-- It cannot catch deletion of the MOST RECENT rows. Delete the tail and the
-- survivors are still self-consistent, genesis is untouched, and the walk from
-- genesis reaches everything left — because v_reachable and v_total shrank
-- together. Tail truncation is invisible to all three.
--
-- It is reachable: audit_events_immutable() returns OLD for a DELETE whenever
-- current_setting('app.allow_audit_purge') = 'on', the trigger is SECURITY
-- INVOKER, and service_role holds DELETE. One GUC and a DELETE removes the
-- entries describing whatever just happened.
--
-- ── WHY THIS IS THE FIX, AND WHY IT IS NOT ALREADY DONE ────────────────────
-- audit_chain_head() exists precisely so the head can be anchored somewhere the
-- database cannot reach back into — that is what makes truncation detectable.
-- It was introduced in 305_audit_chain_insider_write_lock.sql and cited in
-- docs/24 GI-2 as the answer. Measured 2026-08-22:
--
--     grep -rn "audit_chain_head" src/ supabase/functions/ scripts/   → 0
--     grep -rn "audit_chain_head" supabase/migrations/*.sql | grep -i cron → 0
--
-- ZERO callers. No cron, no edge function, no script. Nothing anchors anything.
-- 809_what_was_never_called_is_not_a_feature.sql:117 already lists it among the
-- never-called routines it KEEPS deliberately "because it is money or authority
-- or the audit trail." The decision not to delete it was right. It was never
-- followed by wiring it.
--
-- For a product whose headline differentiator is a tamper-evident ledger sold
-- to regulated buyers, this is the one gap their diligence is built to find.
--
-- ── WHY IT EXTENDS RATHER THAN REWRITES THE VERIFIER ───────────────────────
-- Reproducing verify_audit_chain_internal to add a fourth check would mean
-- transcribing 100+ lines of correct, load-bearing code to append to it. This
-- adds a table, a sweep and a standalone verifier instead; existing callers of
-- the old verifier keep working unchanged and can adopt the new one deliberately.
--
-- ⚠ WHAT THIS DOES AND DOES NOT GIVE YOU. An in-database anchor detects a
-- truncation that happens BETWEEN two sweeps, which is the realistic case and
-- the one nothing catches today. It does NOT survive an attacker who also
-- rewrites the anchors — the table is append-only by trigger, but a
-- sufficiently privileged actor inside this database could still reach it.
-- Genuine external anchoring means shipping the same tuple off the box
-- (object storage with versioning + object-lock, or a timestamp authority).
-- The sweep below is written so that step is a small edge function reading
-- audit_chain_anchors, not another schema change. Do not describe this to a
-- buyer as external anchoring until that exists.
-- ============================================================================

begin;

-- ── 1. The anchors ─────────────────────────────────────────────────────────
create table if not exists public.audit_chain_anchors (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  anchored_at   timestamptz not null default now(),
  head_hash     text not null,
  head_at       timestamptz,
  event_count   bigint not null,
  -- Set once the tuple has been copied somewhere outside this database. Null
  -- means "recorded here only", and the distinction is the whole point: an
  -- anchor an insider can rewrite is a weaker claim than one they cannot.
  exported_at   timestamptz,
  export_ref    text
);

comment on table public.audit_chain_anchors is
  'Periodic (tenant, head_hash, count) snapshots of the audit chain. Append-only. '
  'Their purpose is to make TAIL TRUNCATION detectable — the one tamper the '
  'content/genesis/reachability checks in verify_audit_chain_internal cannot see, '
  'because deleting the newest rows leaves everything that remains self-consistent.';

create index if not exists audit_chain_anchors_tenant_at_idx
  on public.audit_chain_anchors (tenant_id, anchored_at desc);

alter table public.audit_chain_anchors enable row level security;
-- Deny-all to anon/authenticated, matching the 30 other service-role-only
-- tables. Reads go through the SECURITY DEFINER verifier below, which checks
-- membership itself.
revoke all on public.audit_chain_anchors from public, anon, authenticated;
grant select, insert on public.audit_chain_anchors to service_role;

-- An anchor that can be edited proves nothing.
--
-- ⚠ DELETE HAS THE SAME SANCTIONED ESCAPE AS audit_events, AND MUST. The table
-- is `on delete cascade` from tenants, so a blanket DELETE block would make
-- delete_tenant fail on a table it has to be able to clear — a governance
-- control that breaks tenant deletion is not a control, it is an outage. Keyed
-- to the SAME `app.allow_audit_purge` GUC that audit_events_immutable() uses, so
-- there is one sanctioned purge path in this schema rather than two.
-- UPDATE is refused unconditionally: nothing legitimate ever rewrites an anchor.
create or replace function public.audit_chain_anchors_immutable()
returns trigger language plpgsql as $fn$
begin
  if TG_OP = 'DELETE' and coalesce(current_setting('app.allow_audit_purge', true), '') = 'on' then
    return OLD;
  end if;
  raise exception 'audit_chain_anchors is append-only — an anchor that can be rewritten is not evidence';
end $fn$;

drop trigger if exists audit_chain_anchors_no_change on public.audit_chain_anchors;
create trigger audit_chain_anchors_no_change
  before update or delete on public.audit_chain_anchors
  for each row execute function public.audit_chain_anchors_immutable();

-- ── 2. The sweep, which is also the detector ───────────────────────────────
-- Comparing each new reading against the previous anchor is what turns a log
-- into an alarm. Two things are impossible without tampering:
--   * event_count going DOWN (audit_events is append-only)
--   * the previously anchored head_hash no longer existing in the chain
create or replace function public.anchor_audit_chains()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $fn$
declare
  r            record;
  v_head       jsonb;
  v_prev       public.audit_chain_anchors;
  v_written    int := 0;
  v_alarms     int := 0;
  v_findings   jsonb := '[]'::jsonb;
  v_reason     text;
begin
  for r in select id from public.tenants loop
    -- audit_chain_head asserts membership OR service_role; this runs as the
    -- definer, so the service_role branch applies.
    v_head := public.audit_chain_head(r.id);
    if coalesce(v_head->>'head_hash', '') = '' then continue; end if;   -- nothing recorded yet

    select * into v_prev from public.audit_chain_anchors
     where tenant_id = r.id order by anchored_at desc limit 1;

    if v_prev.id is not null then
      v_reason := null;
      if (v_head->>'count')::bigint < v_prev.event_count then
        v_reason := format('event_count fell from %s to %s', v_prev.event_count, v_head->>'count');
      elsif not exists (select 1 from public.audit_events
                         where tenant_id = r.id and hash = v_prev.head_hash) then
        v_reason := format('previously anchored head %s is no longer in the chain', left(v_prev.head_hash, 16));
      end if;

      if v_reason is not null then
        v_alarms := v_alarms + 1;
        v_findings := v_findings || jsonb_build_object('tenant_id', r.id, 'reason', v_reason);
        -- Record the alarm IN the chain it is about. If that write is itself
        -- removed later, the next sweep says so again.
        perform public.append_audit_event_internal(
          r.id, 'audit-anchor', 'system', 'Audit chain anchor mismatch', 'security',
          jsonb_build_object('reason', v_reason,
                             'previous_anchor_at', v_prev.anchored_at,
                             'previous_count', v_prev.event_count,
                             'current_count', (v_head->>'count')::bigint));
      end if;
    end if;

    insert into public.audit_chain_anchors (tenant_id, head_hash, head_at, event_count)
    values (r.id, v_head->>'head_hash', (v_head->>'head_at')::timestamptz, (v_head->>'count')::bigint);
    v_written := v_written + 1;
  end loop;

  return jsonb_build_object('ok', v_alarms = 0, 'anchored', v_written,
                            'alarms', v_alarms, 'findings', v_findings);
end $fn$;

revoke all on function public.anchor_audit_chains() from public, anon, authenticated;

-- ── 3. The verifier a caller can adopt ─────────────────────────────────────
-- Deliberately separate from verify_audit_chain_internal: this one answers
-- "has anything been removed since we last looked?", which the other three
-- checks structurally cannot.
create or replace function public.verify_audit_chain_anchored(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'extensions'
as $fn$
declare v_prev public.audit_chain_anchors; v_count bigint; v_head text;
begin
  if coalesce(auth.role(), '') <> 'service_role' and not exists (
    select 1 from profiles where user_id = auth.uid() and tenant_id = p_tenant_id
  ) then
    raise exception 'not a member of this tenant';
  end if;

  select * into v_prev from public.audit_chain_anchors
   where tenant_id = p_tenant_id order by anchored_at desc limit 1;
  if v_prev.id is null then
    -- Never anchored is NOT "intact". Saying otherwise is the zero-comparisons
    -- clean result this repository keeps paying for.
    return jsonb_build_object('anchored', false, 'intact', null,
      'reason', 'no anchor recorded yet — this proves nothing about truncation');
  end if;

  select count(*) into v_count from public.audit_events where tenant_id = p_tenant_id;
  select hash into v_head from public.audit_events
   where tenant_id = p_tenant_id and hash = v_prev.head_hash limit 1;

  if v_count < v_prev.event_count then
    return jsonb_build_object('anchored', true, 'intact', false,
      'reason', format('%s event(s) present, %s anchored at %s — the chain lost rows',
                       v_count, v_prev.event_count, v_prev.anchored_at));
  end if;
  if v_head is null then
    return jsonb_build_object('anchored', true, 'intact', false,
      'reason', format('the head anchored at %s is no longer in the chain', v_prev.anchored_at));
  end if;
  return jsonb_build_object('anchored', true, 'intact', true,
    'since', v_prev.anchored_at, 'anchored_count', v_prev.event_count, 'current_count', v_count);
end $fn$;

revoke all on function public.verify_audit_chain_anchored(uuid) from public, anon;
grant execute on function public.verify_audit_chain_anchored(uuid) to authenticated;

-- ── 4. Daily, at a quiet hour ──────────────────────────────────────────────
do $cron$
begin
  perform cron.unschedule('audit-chain-anchor-daily');
exception when others then null;
end $cron$;
select cron.schedule('audit-chain-anchor-daily', '35 3 * * *', 'select public.anchor_audit_chains()');

-- ── PROOF ───────────────────────────────────────────────────────────────────
-- Fixtures built and rolled back in this transaction, so it is non-vacuous AND
-- replayable on an empty database.
do $verify$
declare
  v_t uuid; v_res jsonb; v_first text; v_n bigint;
begin
  -- Schema half: true wherever this runs.
  if to_regclass('public.audit_chain_anchors') is null then
    raise exception 'ANCHOR FAILED: table missing'; end if;
  if to_regprocedure('public.anchor_audit_chains()') is null
     or to_regprocedure('public.verify_audit_chain_anchored(uuid)') is null then
    raise exception 'ANCHOR FAILED: a function is missing'; end if;
  if not exists (select 1 from cron.job where jobname = 'audit-chain-anchor-daily') then
    raise exception 'ANCHOR FAILED: the sweep is not scheduled — an anchor nobody writes is the defect this fixes'; end if;

  -- Behavioural half, on a workspace this block creates.
  insert into tenants (name, slug) values ('__anchor_probe', '__anchor_probe') returning id into v_t;

  perform public.append_audit_event_internal(v_t, 'probe', 'system', 'first', 'security', '{}'::jsonb);
  perform public.append_audit_event_internal(v_t, 'probe', 'system', 'second', 'security', '{}'::jsonb);
  v_res := public.anchor_audit_chains();
  select count(*) into v_n from public.audit_chain_anchors where tenant_id = v_t;
  if v_n <> 1 then raise exception 'ANCHOR FAILED: expected 1 anchor for the probe tenant, found %', v_n; end if;

  -- Intact while nothing has been removed.
  v_res := public.verify_audit_chain_anchored(v_t);
  if (v_res->>'intact')::boolean is not true then
    raise exception 'ANCHOR FAILED: a chain with nothing removed reports not intact: %', v_res; end if;

  -- ── THE LOAD-BEARING ASSERTION: truncate the TAIL and it must be caught.
  -- This is precisely what the content / genesis / reachability checks miss.
  perform set_config('app.allow_audit_purge', 'on', true);
  delete from public.audit_events
   where id = (select id from public.audit_events where tenant_id = v_t
                order by created_at desc limit 1);
  perform set_config('app.allow_audit_purge', 'off', true);

  v_res := public.verify_audit_chain_anchored(v_t);
  if (v_res->>'intact')::boolean is not false then
    raise exception 'ANCHOR FAILED: tail truncation was NOT detected — this migration accomplishes nothing (%)', v_res;
  end if;

  -- And confirm the OLD verifier still says intact, which is the whole reason
  -- this exists. If this ever starts failing, the gap has closed elsewhere and
  -- this migration's justification should be re-read rather than assumed.
  if (public.verify_audit_chain_internal(v_t)->>'intact')::boolean is not true then
    raise notice 'NOTE: verify_audit_chain_internal now also catches tail truncation — re-read this migration''s rationale';
  end if;

  raise notice 'audit anchoring: tail truncation detected by the anchor and missed by the hash checks, as designed';

  -- Undo everything this block created. The purge GUC stays on across BOTH
  -- deletes because the anchors table now shares audit_events' sanctioned
  -- escape — and the tenant delete cascades into it, so it needs the same.
  perform set_config('app.allow_audit_purge', 'on', true);
  delete from public.audit_events where tenant_id = v_t;
  delete from public.audit_chain_anchors where tenant_id = v_t;
  delete from tenants where id = v_t;
  perform set_config('app.allow_audit_purge', 'off', true);
end $verify$;

commit;
