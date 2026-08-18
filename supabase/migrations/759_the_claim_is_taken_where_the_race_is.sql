-- 759_the_claim_is_taken_where_the_race_is.sql
-- ==========================================================================
-- WHY: a migration number has now been double-claimed FOUR times — 669 on
-- 2026-08-10, 715 and 717 on 2026-08-12, and 754 today — and every previous
-- note diagnosed it slightly wrong. Setting the record straight, because the
-- fix follows from the diagnosis and the wrong diagnosis gives a fix that
-- narrows the window and calls it closed.
--
-- WHAT `npm run migrate:next` ALREADY DOES RIGHT. It reads the union of three
-- sources — local files, origin/main, and the PRODUCTION LEDGER — and it has
-- been right every single time. Verified by running it during the 756/757
-- collision today: `local 755 · origin 755 · prod ledger 757`, correctly
-- answering 758 while two migrations sat applied-but-unmerged. It is not
-- `ls | tail -1`. It is not missing a source. It answers correctly and the
-- collision happens anyway.
--
-- THE ACTUAL HOLE, stated exactly. The three sources record what has ALREADY
-- HAPPENED. `schema_migrations` gains a row at APPLY. So between the moment
-- one agent claims a number and the moment it applies, that number exists
-- nowhere the other agent can look:
--   * not in their local tree — separate worktrees, or simply unpulled
--   * not on origin/main — the work is on a branch, or uncommitted
--   * not in the ledger — nothing has been applied yet
-- On 717 that window was SEVENTEEN SECONDS. The `wx` flag makes the local
-- file an atomic claim, but a file binds ONE DISK; production is the shared
-- resource, and until today nothing held a claim there.
--
-- THE FIX: TAKE THE CLAIM WHERE THE RACE IS. This table lives on production,
-- and `migrate:next` inserts into it BEFORE it writes the local file. The
-- primary key on `num` is the mutual exclusion — two agents racing cannot both
-- insert 758; the loser gets zero rows back and moves to 759. The claim is
-- visible to every session the instant it is made, which is the property the
-- other three sources cannot have.
--
-- ⚠ CLAIMS DO NOT EXPIRE, AND THAT IS DELIBERATE. A crashed session burns a
-- number. That is CHEAP: migrations replay in filename order and gaps are
-- already normal here — 335 and 463-464 are missing today and nothing notices.
-- Auto-expiry would hand a number to a second agent while the first is still
-- writing its migration, which manufactures the exact collision this exists to
-- stop. Trading a permanent duplicate for a harmless gap is the whole point.
-- Stale claims are RELEASED BY A HUMAN: `npm run migrate:next -- --release 758`.
--
-- ⚠ WHAT THIS DOES NOT FIX, so nobody reads it as more than it is: it binds
-- only agents who RUN the tool. Someone who hand-writes `760_foo.sql` still
-- collides, exactly as the 669 note said — "a convention only holds once
-- everyone has it". certify's migration-numbering arm remains the backstop.
-- ==========================================================================

begin;

create table if not exists public.migration_number_claims (
  num          integer      primary key,
  filename     text         not null,
  claimed_at   timestamptz  not null default now(),
  claimed_by   text         not null default coalesce(current_setting('application_name', true), 'unknown'),
  released_at  timestamptz,
  release_note text
);

comment on table public.migration_number_claims is
  'A migration number claimed but not yet applied. Written by scripts/migration-next.mjs BEFORE it creates the local file, so a claim is visible to every session immediately — schema_migrations only gains a row at APPLY, which is the window 669/715/717/754 all raced through. The PRIMARY KEY on num IS the mutual exclusion. Claims never expire: a burned number is a harmless gap (335 and 463-464 are already missing), while auto-expiry would re-create the collision. Release with `npm run migrate:next -- --release NNN`.';

comment on column public.migration_number_claims.released_at is
  'Set when a human releases a stale claim. The row is KEPT rather than deleted so the number''s history survives — a released-then-reused number is exactly the shape worth being able to read back later.';

-- Claims are infrastructure for the tooling, which reaches production through
-- the management API as `postgres`. Nothing in the app reads or writes this.
-- Default-deny perimeter per the standing rule (migs 610/630): revoke from the
-- roles a browser can reach, and grant to nobody.
revoke all on public.migration_number_claims from public, anon, authenticated;

-- Backfill every number this repo has already spent, so the very first claim
-- after this migration cannot hand back a number that is taken. Reads the
-- ledger — the only source available from inside the database.
insert into public.migration_number_claims (num, filename, claimed_by, released_at, release_note)
select distinct on (num) num, filename, 'backfill-759', now(),
       'applied before this table existed; recorded so the sequence cannot regress'
from (
  select (substring(filename from '^([0-9]{3})_'))::int as num, filename
  from public.schema_migrations
  where filename ~ '^[0-9]{3}_'
) s
order by num, filename
on conflict (num) do nothing;

commit;
