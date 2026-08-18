-- ============================================================================
-- 755 — the trust screen asks the question enforcement answers.
--
-- THE DEFECT, measured not argued. `list_de_trust_surface` backs the Trust &
-- Autonomy section of the employee file — the screen a customer reads to learn
-- what an employee may do on its own. Its write-back branch resolved ONE key,
-- 'action_execute'. `decide_action_execution` resolves a CHAIN, specific first:
--   ['action:' || category, <the action's own key>, 'action_execute']
-- so the screen and the gate answered different questions, and the dials panel
-- has written 'action:<category>' since mig 618.
--
-- Proven on production in an ALWAYS-ABORTING transaction, 2026-08-18, both
-- directions reachable:
--   dial OFF + generic ON  ->  screen true,  enforcement false   (fail-safe)
--   dial ON  + no generic  ->  screen FALSE, enforcement TRUE    (not)
-- The second is a governance surface reporting a capability as OFF while the
-- employee is permitted to act. Same class as the hardcoded "Enforcement: Live"
-- tile Stage A removed, on a screen where being wrong matters more.
--
-- WHY IT WAS RIGHT ONCE. Mig 496's comment is preserved in the diff and is
-- worth reading: it chose the generic key deliberately, because back then the
-- resolver stopped at the first action_type having ANY row and provisioning
-- guaranteed 'action_execute' rows everywhere — so a category-shaped row would
-- read ON here and do nothing at runtime. MIG 618 ENDED BOTH FACTS: it reversed
-- the chain and deleted the workspace rows. The writer was updated for 618. The
-- reader was not. A comment describing a world that no longer exists is how the
-- next reader inherits the mistake, so it is replaced with the measurement.
--
-- The body below is generated from the LIVE pg_get_functiondef, with exactly
-- one expression changed — not retyped, so nothing else can drift.
--
-- ⛔ AND IT WITHDRAWS 754. Yesterday's migration added
-- `get_de_effective_permissions`, a NEW reader answering the same question,
-- written before I had read `list_de_trust_surface` properly. Shipping it would
-- leave two readers of one truth — the two-paths-one-counted trap this repo has
-- already recorded — and it put a routine on the `authenticated` EXECUTE
-- surface that `supabase/baseline/execute-allowlist.json` does not pin, so
-- certify goes red until it is gone. Fixing the reader the screen already uses
-- is strictly better than adding a second one. 754 is withdrawn here rather
-- than left as dead surface.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.list_de_trust_surface(p_de_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant uuid;
  v_out jsonb;
BEGIN
  -- Tenant comes from the employee row, never from auth_tenant_id(): a
  -- service-role caller has no tenant claim and must not get a silent empty.
  SELECT d.tenant_id INTO v_tenant FROM digital_employees d WHERE d.id = p_de_id;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'digital employee not found';
  END IF;

  IF NOT (
       coalesce(auth.role(), '') = 'service_role'
    OR is_platform_admin()
    OR (v_tenant = auth_tenant_id() AND can_access_de(p_de_id))
  ) THEN
    RAISE EXCEPTION 'insufficient_permission: you are not assigned to this digital employee';
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'capability_key', c.capability_key,
             'label',          c.label,
             'kind',           c.kind,
             'category',       c.category,
             'dialable',       c.dialable,
             'destructive',    c.destructive,
             'enforcement',    jsonb_build_object(
                                 'uses_confidence', c.uses_confidence,
                                 'uses_amount',     c.uses_amount),
             -- The most specific policy: this employee's own row first, else
             -- the workspace-wide row (both with no category qualifier —
             -- matching the seeded shapes).
             'policy', (SELECT to_jsonb(tp) FROM trust_policies tp
                         WHERE tp.tenant_id = v_tenant
                           AND tp.action_category = c.capability_key
                           AND tp.source_category IS NULL
                           AND (tp.de_id = p_de_id OR tp.de_id IS NULL)
                         ORDER BY (tp.de_id = p_de_id) DESC NULLS LAST
                         LIMIT 1),
             -- The enforcement truth for this employee, from the one resolver
             -- every gate uses. NULL for destructive entries: the destructive
             -- gate sits above the dial, so showing a dial there would lie.
             'dial', CASE WHEN NOT c.dialable THEN NULL
                     -- ⚠ mig 755. This read the GENERIC key alone, on mig
                     -- 496's reasoning that the chain "stops at the first
                     -- action_type that has ANY row" and that provisioning put
                     -- 'action_execute' rows everywhere. MIGRATION 618 ENDED
                     -- BOTH FACTS: it reversed the chain to ask the SPECIFIC
                     -- key first and deleted the workspace rows. The dials
                     -- panel was updated to write 'action:<category>'; this
                     -- reader was not, so the screen answered a question
                     -- enforcement had stopped asking.
                     -- Measured in an aborting transaction on 2026-08-18,
                     -- BOTH directions reachable:
                     --   dial OFF + generic ON  -> screen true,  gate false
                     --   dial ON  + no generic  -> screen false, gate TRUE
                     -- The second is a governance screen showing a capability
                     -- as off while the employee is permitted to act.
                     -- It now asks the SAME chain, in the SAME order, that
                     -- decide_action_execution asks.
                     WHEN c.kind = 'writeback' THEN
                       (SELECT to_jsonb(r)
                          FROM resolve_de_autonomy_chain(
                                 v_tenant,
                                 ARRAY['action:' || c.category, NULL, 'action_execute'],
                                 p_de_id, c.category, NULL) r)
                     ELSE
                       (SELECT to_jsonb(r)
                          FROM resolve_de_autonomy(v_tenant, c.capability_key, p_de_id, NULL) r)
                     END
           )
           ORDER BY CASE c.kind WHEN 'answer' THEN 0 WHEN 'playbook' THEN 1
                                WHEN 'writeback' THEN 2
                                WHEN 'action_category' THEN 3 ELSE 4 END,
                    c.category NULLS FIRST,
                    c.capability_key
         ), '[]'::jsonb)
    INTO v_out
    FROM de_trust_surface_candidates(v_tenant, p_de_id) c;

  RETURN v_out;
END $function$
;

-- Withdraw 754's reader: superseded by the fix above, and un-pinned on the
-- EXECUTE perimeter. Restores that surface to exactly its allowlisted state.
drop function if exists public.get_de_effective_permissions(uuid);
