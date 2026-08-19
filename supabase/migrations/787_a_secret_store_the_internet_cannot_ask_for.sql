-- 787_a_secret_store_the_internet_cannot_ask_for.sql
-- ============================================================================
-- Found by the anon-role probe that register G-6 said Workstream C still owed.
--
-- docs/50's attack signed in as a real user of another tenant and found no
-- holes. It never asked the question below that one: what can a caller holding
-- ONLY the publishable key — the internet — reach? 37 checks later the answer
-- is "nothing", and this migration is about why that is currently true.
--
-- ── The finding ────────────────────────────────────────────────────────────
-- 244 tables in `public` grant SELECT to `anon`. Of those, **18 have RLS
-- enabled and ZERO policies**, which denies everyone — so anon reads nothing
-- from them today. They are safe by DEFAULT-DENY, not by any decision to keep
-- anon out. The grant is sitting there, and the day someone adds one permissive
-- policy for a legitimate reason, the internet gains read access to that table
-- in the same statement. Nobody would be reviewing the grant at that moment;
-- they would be reviewing the policy.
--
-- Six of the eighteen hold credentials or their references:
--
--   connector_secrets          vault refs for every connected system
--   widget_key_secrets         widget identity secrets
--   specialist_source_secrets  specialist source credentials
--   scim_tokens                SCIM provisioning tokens
--   oauth_connect_states       in-flight OAuth state
--   platform_runtime_config    platform runtime configuration
--
-- ── Why revoking is safe, and why that is provable rather than hoped ───────
-- A table with RLS on and NO policies denies every role that goes through RLS.
-- So nothing can currently be reading these as anon or authenticated — there is
-- no policy that would let it. `service_role` bypasses RLS entirely and is
-- untouched here, which is how the platform's own code reaches them.
--
-- Therefore this revoke removes a privilege that cannot be in use. Zero
-- behavioural change; the latent grant is what goes.
--
-- Scope note: this is the six credential-bearing tables only. The other twelve
-- zero-policy tables carry caches, receipts and counters — the same latent
-- shape, materially less to lose, and left for a deliberate sweep rather than
-- folded into a security fix where they would be reviewed less carefully.
-- ============================================================================

revoke all on public.connector_secrets          from anon, authenticated;
revoke all on public.widget_key_secrets         from anon, authenticated;
revoke all on public.specialist_source_secrets  from anon, authenticated;
revoke all on public.scim_tokens                from anon, authenticated;
revoke all on public.oauth_connect_states       from anon, authenticated;
revoke all on public.platform_runtime_config    from anon, authenticated;

-- Proof, in the migration, that the grant is gone rather than assumed gone.
do $$
declare v_left int;
begin
  select count(*) into v_left
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee in ('anon', 'authenticated')
     and table_name in ('connector_secrets', 'widget_key_secrets', 'specialist_source_secrets',
                        'scim_tokens', 'oauth_connect_states', 'platform_runtime_config');
  if v_left <> 0 then
    raise exception 'expected 0 remaining anon/authenticated grants on the secret stores, found %', v_left;
  end if;
end $$;
