-- ============================================================
-- Migration 079: anon EXECUTE grant sweep — the follow-up promised
-- while shipping platform capability grants (078), which fixed 2 of
-- these functions in passing but flagged the rest as a separate,
-- larger finding rather than scope-creep into functions that build
-- had no reason to touch.
--
-- ROOT CAUSE (same class as migration 048's "exhaustive secdef null
-- bypass sweep" — evidently not fully closed, and not consistently
-- followed by every migration added since): Supabase's own default
-- schema privileges auto-grant EXECUTE to anon+authenticated on every
-- new function unless a migration explicitly revokes it. Many
-- migrations only ever ran `revoke all ... from PUBLIC`, which does
-- NOT strip a grant made directly to the named `anon` role — PUBLIC-
-- revoke is not the same as named-role-revoke.
--
-- SCOPE, precisely determined (not guessed): a live query against
-- information_schema found 136 distinct functions in the public
-- schema carrying a stray anon EXECUTE grant. ~104 of those are
-- pgvector extension type-support functions (vector/halfvec/sparsevec
-- arithmetic, comparison, and I/O operators — e.g. vector_add,
-- halfvec_cmp, cosine_distance) and SQL-language read-only helpers
-- with SECURITY INVOKER — these run with the CALLER's own privileges,
-- touch no table directly, and are exactly as safe to leave
-- executable by anyone as the built-in `+` or `<` operators they
-- implement. Not touched here — revoking them would be pure noise.
--
-- The real list is the 32 SECURITY DEFINER functions below — these
-- run with ELEVATED privileges and are the ones worth being precise
-- about. Every one was individually verified (not assumed) to already
-- carry a real internal guard against an unauthenticated caller —
-- auth_tenant_id()/is_platform_admin() tenant-mismatch checks, an
-- explicit `profiles` membership + is_active lookup, or (for trigger
-- functions) never being directly invocable in a way that matters.
-- None of the 32 turned out to be a genuine unauthenticated-write
-- hole — the grants were sloppy hygiene, not an exploitable gap. This
-- migration closes the hygiene issue; no application logic changes.
--
-- SEPARATE FINDING, worth its own note (not fixed here, nothing to
-- fix at the grant level): detect_exceptions, ingest_document, and
-- resolve_exception exist in the live database with NO corresponding
-- `create function` statement anywhere in supabase/migrations/*.sql —
-- they were created directly against the database outside migration
-- tracking at some point. Their current live bodies were pulled via
-- pg_get_functiondef and confirmed to carry the same real guard as
-- everything else here, so the anon-grant fix below is correct and
-- safe — but a fresh migration replay of this project would NOT
-- recreate these three functions, the same class of "the migrations
-- folder doesn't fully reflect the live schema" gap already known
-- from the dev-staging-environment build earlier this project. Not
-- addressed here (would mean writing a migration that recreates their
-- exact live bodies verbatim, a bigger and separate piece of work);
-- flagged in memory for whoever next needs a clean migration replay.
-- ============================================================

revoke all on function public.append_audit_event(uuid, text, text, text, text, jsonb) from anon;
revoke all on function public.auth_tenant_id() from anon;
revoke all on function public.close_opportunity_lost(uuid, text) from anon;
revoke all on function public.close_opportunity_won(uuid, uuid, boolean, uuid) from anon;
revoke all on function public.compute_account_health(uuid) from anon;
revoke all on function public.compute_tenant_health(boolean) from anon;
revoke all on function public.compute_trust_evidence(uuid, text) from anon;
revoke all on function public.create_digital_employee(text, text, text, text, text, text, integer, boolean) from anon;
revoke all on function public.create_onboarding_project(uuid, uuid, text, date) from anon;
revoke all on function public.detect_exceptions(uuid, uuid) from anon;
revoke all on function public.guard_against_demo_tenant_assignment() from anon;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.ingest_document(uuid, uuid, text, text, jsonb, uuid) from anon;
revoke all on function public.install_starter_onboarding_template() from anon;
revoke all on function public.install_technical_specialist() from anon;
revoke all on function public.invalidate_answer_cache() from anon;
revoke all on function public.publish_adapter_template(uuid) from anon;
revoke all on function public.publish_onboarding_template(uuid) from anon;
revoke all on function public.request_trust_promotion(uuid) from anon;
revoke all on function public.resolve_exception(uuid, text, text, uuid, text) from anon;
revoke all on function public.resolve_onboarding_signoff(uuid, text) from anon;
revoke all on function public.resume_playbook_on_task(uuid, text) from anon;
revoke all on function public.save_adapter_template(text, text, text, jsonb, uuid, uuid) from anon;
revoke all on function public.seed_trust_policies() from anon;
revoke all on function public.set_onboarding_project_status(uuid, text) from anon;
revoke all on function public.set_specialist_source_secret(uuid, text) from anon;
revoke all on function public.set_work_item_framing(text, text) from anon;
revoke all on function public.trust_check_eval_regression() from anon;
revoke all on function public.trust_check_guardrail_block() from anon;
revoke all on function public.update_onboarding_item(uuid, text, text, text, text) from anon;
revoke all on function public.upsert_action_definition(uuid, text, uuid, text, text, text, text, text, uuid, jsonb, jsonb, jsonb) from anon;
revoke all on function public.verify_audit_chain(uuid) from anon;
