-- Residual fixes from the 2026-07-06 adversarial isolation audit (038-040).
-- Two functions flagged as vulnerable in the sub-agent's audit were not
-- actually revoked in the parent agent's fix pass. Neither has a frontend
-- call site (confirmed via grep across src/) -- both are internal
-- dispatcher/seeding functions only ever meant to be invoked by the
-- service role (cron dispatch, or server-side onboarding of a new DE).

revoke execute on function public.dispatch_due_triggers(uuid) from public, anon, authenticated;
revoke execute on function public.seed_default_grants(text, uuid, text) from public, anon, authenticated;
