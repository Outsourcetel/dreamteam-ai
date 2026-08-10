-- 699 — a policy without its grant is a door with no handle (G-D fix).
--
-- mig 691 gave review_time_standards an RLS read policy and revoked writes —
-- but never GRANTED SELECT, and this database's hardened defaults hand out
-- nothing. Result: 42501 for every authenticated reader — the Settings card
-- would have loaded blank on its first open. Caught by
-- tests/review-minutes.test.ts driving the REAL public-signup flow before any
-- founder ever saw it (the RPCs passed all along: SECURITY DEFINER bypasses
-- table grants, which is exactly why an RPC-only proof was not enough).
--
-- RLS still scopes every row (platform defaults + own tenant only); the grant
-- and the policy are a PAIR, and 691 shipped half of one.

grant select on review_time_standards to authenticated;

do $$
begin
  if not has_table_privilege('authenticated', 'public.review_time_standards', 'SELECT') then
    raise exception '699: authenticated still cannot SELECT review_time_standards';
  end if;
  -- The write revokes of 691 must survive this fix.
  if has_table_privilege('authenticated', 'public.review_time_standards', 'INSERT')
     or has_table_privilege('authenticated', 'public.review_time_standards', 'UPDATE')
     or has_table_privilege('authenticated', 'public.review_time_standards', 'DELETE') then
    raise exception '699: a write privilege leaked back in with the read grant';
  end if;
end $$;
