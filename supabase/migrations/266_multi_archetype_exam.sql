-- ═══════════════════════════════════════════════════════════════
-- 266 — Multi-archetype exam breadth (docs/20 follow-on)
--
-- Some DEs genuinely span more than one role — a "Website & Growth" DE does
-- both SEO and paid ads. The single archetype_key (used for certification
-- identity) can't represent that, so its exam would miss half its job.
--
-- exam_archetype_keys lets a DE be EXAMINED across additional archetypes
-- beyond its primary. Certification identity stays single (archetype_key) —
-- the DE certifies under its primary, but its exam draws from universal +
-- primary + these extras. Empty array (the default) = today's behavior, so
-- this is a zero-impact addition for every existing DE.
-- ═══════════════════════════════════════════════════════════════

alter table digital_employees
  add column if not exists exam_archetype_keys text[] not null default '{}';

comment on column digital_employees.exam_archetype_keys is
  'Extra archetypes this DE is examined on, beyond its primary archetype_key. Exam suite = universal (golden_qa.archetype_key IS NULL) + primary + these. Certification still uses the single archetype_key.';
