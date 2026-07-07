-- Migration 057: migration 056's column-level REVOKE on profiles
-- (role, layer, tenant_id, is_active) had NO EFFECT -- confirmed live by
-- re-attempting the exact self-escalation exploit it was meant to close,
-- which still succeeded after 056 was applied.
--
-- Root cause: profiles already had a pre-existing TABLE-WIDE
-- `GRANT UPDATE ON profiles TO authenticated` (and, worse, to `anon`)
-- covering every column. A column-specific REVOKE does not narrow a
-- broader table-level grant the same role already holds -- Postgres
-- authorizes a column update if EITHER the column-specific grant OR the
-- table-wide grant permits it, so the table-wide grant alone kept every
-- column, including the four this was meant to protect, fully writable.
-- This is the same class of "narrower revoke doesn't touch a broader
-- grant" mistake this codebase's history has repeatedly flagged for
-- PUBLIC-vs-role grants on functions -- here it recurred on a table.
--
-- Fix: revoke the table-wide UPDATE grant entirely from anon/authenticated,
-- then re-grant UPDATE on only the columns that are actually safe for a
-- user to self-edit (full_name, avatar, last_seen_at). anon gets no
-- UPDATE on profiles at all -- it never legitimately needs any (every
-- write path for an unauthenticated caller goes through a SECURITY
-- DEFINER RPC, none of which are affected by this revoke since they run
-- as their owner's privileges, not the calling role's).
-- =====================================================================

revoke update on public.profiles from anon, authenticated;
grant update (full_name, avatar, last_seen_at) on public.profiles to authenticated;
