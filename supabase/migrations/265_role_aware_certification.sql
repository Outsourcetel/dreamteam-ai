-- ═══════════════════════════════════════════════════════════════
-- 265 — Role-aware certification exams, Step A + B mechanism (docs/20)
--
-- The cert exam gates DE autonomy (G6), but it was NOT role-scoped: golden_qa
-- had no role dimension and eval-run loaded every active question, so a
-- Product Support DE was graded on renewal / account-success scenarios that
-- aren't its job (it failed 62.5%, mostly on out-of-role questions).
--
-- Prerequisite gap this closes: a DE's archetype was not first-class — it
-- lived only on downstream cert/training/routing records, never on the DE.
-- Without a canonical archetype there is nothing to scope an exam (or
-- training, or model routing) against.
--
-- This migration ships the GLOBAL mechanism only (columns + resolver +
-- backfill). Tagging a tenant's existing questions is a data op; seeding
-- per-archetype banks for new tenants is Step D (follow-on). All columns are
-- nullable ⇒ applying this breaks nothing: an untagged question is universal
-- (every DE sits it) and an unresolved DE archetype means the DE sits only
-- the universal set — strictly fairer than today, never worse.
-- ═══════════════════════════════════════════════════════════════

-- ── Step A: archetype is now first-class on the employee ──
alter table digital_employees add column if not exists archetype_key text;

-- Backfill from the most recent certification, the only place archetype was
-- reliably recorded until now. Unmatched DEs stay NULL (generalist).
update digital_employees d
   set archetype_key = rc.archetype_key
  from (
        select distinct on (de_id) de_id, archetype_key
          from role_certifications
         where archetype_key is not null
         order by de_id, created_at desc
       ) rc
 where rc.de_id = d.id
   and d.archetype_key is null;

-- Canonical resolver — exams, training and routing all read archetype the
-- same way. Prefer the DE's own column, fall back to its latest cert.
create or replace function resolve_de_archetype(p_de_id uuid)
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select archetype_key from digital_employees where id = p_de_id),
    (select archetype_key from role_certifications
      where de_id = p_de_id and archetype_key is not null
      order by created_at desc limit 1)
  );
$$;

-- ── Step B: the question bank can now be scoped by role ──
-- NULL archetype_key = universal (product knowledge, governance, safety,
-- platform how-to) — applies to every DE. A non-null value scopes the
-- question to that archetype only.
alter table golden_qa add column if not exists archetype_key text;

comment on column golden_qa.archetype_key is
  'NULL = universal (every DE sits it). Non-null scopes the question to that archetype only. Resolved against resolve_de_archetype(de_id) in eval-run.';
