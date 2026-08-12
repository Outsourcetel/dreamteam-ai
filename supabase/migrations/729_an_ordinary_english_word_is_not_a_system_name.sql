-- 729 — an ordinary English word is not the name of a system
--
-- Migration 727 seeded the catalog by deriving each provider's aliases from
-- its own lowercased label. That is the right way to build 75 rows without
-- hand-typing them, and it is also how ~20 ordinary English words became
-- system names: several products ARE common words — Close, Front, Box,
-- monday.com, Linear, Square, Epic, Slack, Notion, Stripe, Toast — and a
-- curated "books" synonym was added to xero on top.
--
-- The consequence was only visible against the real catalog, which nothing
-- tested until now (the matcher's own suite handed it a two-row fixture). Live:
--
--   "we close deals on monday and the team meets in front of the box"
--        -> box, close, front, monday   — ALL at confidence 'exact'
--   "we run a square meal service, epic turnout, linear growth"
--        -> square, epic, linear
--   "our books are a mess"                          -> xero
--
-- matchProvider's docstring says "a false positive is worse than a miss. A miss
-- just means we ask one more question." The DATA inverted that promise, and
-- 'exact' is the confidence a consumer would act on automatically — the
-- discovery interview would have prepared four connectors for a sentence about
-- meeting rooms.
--
-- So this sweeps those aliases out of the seeded rows. It is a filter, not a
-- rewrite: the list of ordinary-English words is AMBIGUOUS_ALIASES in
-- src/lib/connectorApi.ts, scripts/gen-provider-seed.mjs now applies it so a
-- re-generated seed cannot put them back, and certify's provider-catalog
-- section fails if any live alias appears in it.
--
-- NO provider becomes unnameable. Each keeps every distinctive alias it had
-- ("microsoft teams", "monday.com", "canvas lms", "sfdc", "qbo"), and where the
-- ordinary word IS the entire product name — Close, Box, Slack — matchProvider
-- resolves it from the exact CAPITALISED label instead, which is how a customer
-- writes a proper noun. The cost, stated plainly: a bare lowercase "we use
-- slack" now misses. That is the trade the docstring already chose.
--
-- Widening nothing, granting nothing, dropping nothing. One UPDATE of one
-- column, idempotent on re-apply.

begin;

update public.connector_providers
   set aliases = coalesce(
         (select array_agg(a order by ord)
            from unnest(aliases) with ordinality as u(a, ord)
           where a <> all (array[
             'accounting software', 'books', 'box', 'canvas', 'close', 'confluence',
             'dynamics', 'epic', 'front', 'greenhouse', 'guru', 'gusto', 'intercom',
             'lever', 'linear', 'monday', 'notion', 'slack', 'square', 'stripe',
             'teams', 'template', 'toast', 'zero'
           ])),
         '{}'::text[])
 where aliases && array[
         'accounting software', 'books', 'box', 'canvas', 'close', 'confluence',
         'dynamics', 'epic', 'front', 'greenhouse', 'guru', 'gusto', 'intercom',
         'lever', 'linear', 'monday', 'notion', 'slack', 'square', 'stripe',
         'teams', 'template', 'toast', 'zero'
       ];

do $$
declare
  v_stop text[] := array[
    'accounting software', 'books', 'box', 'canvas', 'close', 'confluence',
    'dynamics', 'epic', 'front', 'greenhouse', 'guru', 'gusto', 'intercom',
    'lever', 'linear', 'monday', 'notion', 'slack', 'square', 'stripe',
    'teams', 'template', 'toast', 'zero'
  ];
  v_left int; v_rows int; v_aliases int; v_orphan text;
begin
  -- 1. The sweep actually swept.
  select count(*) into v_left
    from public.connector_providers p, unnest(p.aliases) a
   where a = any (v_stop);
  if v_left > 0 then
    raise exception '729: % ordinary-English alias(es) survived the sweep', v_left;
  end if;

  -- 2. The pairing rule, and it is not decoration. "No ordinary word remains"
  --    is ALSO true of a column that was emptied outright, and of a table that
  --    lost its rows. Both would be a far worse outcome than the bug, and both
  --    would satisfy check 1 silently. So: the catalog is still whole, and the
  --    great majority of aliases are still there.
  select count(*) into v_rows from public.connector_providers where active;
  if v_rows < 50 then
    raise exception '729: the catalog lost rows — only % active providers left', v_rows;
  end if;

  select count(*) into v_aliases
    from public.connector_providers p, unnest(p.aliases) a where p.active;
  if v_aliases < 70 then
    raise exception '729: the sweep gutted the alias column — only % aliases left', v_aliases;
  end if;

  -- 3. And name the specific survivors, because a count is satisfied by the
  --    wrong 70. Each of these is a provider whose ONLY remaining handle is the
  --    alias listed — if the sweep took it, that system became unnameable.
  select string_agg(x.k || ' (lost "' || x.a || '")', ', ' order by x.k) into v_orphan
    from (values
      ('xero','xero'), ('zendesk','zendesk'), ('hubspot','hub spot'),
      ('salesforce','sfdc'), ('quickbooks','qbo'),
      ('monday','monday.com'), ('teams','microsoft teams'),
      ('canvas','canvas lms'), ('dynamics','microsoft dynamics 365'),
      ('template','custom system (from template)')
    ) as x(k, a)
   where not exists (
     select 1 from public.connector_providers p
      where p.provider_key = x.k and x.a = any (p.aliases));
  if v_orphan is not null then
    raise exception '729: the sweep left a provider with no way to be named: %', v_orphan;
  end if;
end $$;

commit;
