-- 496_the_writeback_dial_becomes_visible.sql
-- ============================================================================
-- The second prerequisite for founder decision D4.
--
-- D4 says a renewal employee may keep its own record current without asking.
-- The dial that governs that is de_autonomy(action_type='action_execute',
-- source_category='crm') — and NO SCREEN IN THE PRODUCT CAN SHOW OR UNSET IT:
--
--   * de_trust_surface_candidates derives cards from connected connectors
--     joined to action_definitions. Write-backs are neither — they are their
--     own RPC family — and there are ZERO action_definitions rows in category
--     'crm' platform-wide, so a card could never be produced in ANY tenant.
--   * list_de_trust_surface reads the dial as
--     resolve_de_autonomy(tenant, capability_key, de_id, NULL) — a different
--     key space from the one the gate consults. Disjoint.
--
-- Enabling the dial without fixing this would have shipped a permission that
-- is ON, invisible, and un-turn-off-able — exactly the organ-that-lies shape
-- docs/37 Move 0 exists to remove, and worse than the gap it closes.
--
-- Two changes:
--   1. A 'writeback' card per applicable category, emitted only for an employee
--      that actually works records (holds a case with a write-back-capable
--      entity kind, or a system it may write to).
--   2. The surface reads THE GATE'S KEY for those cards. This matters more than
--      it looks: resolve_de_autonomy_chain returns at the first action_type
--      that has any row for the tenant, and provisioning guarantees
--      'action_execute' rows exist in every real tenant — so an 'action:crm'
--      row would read as ON in the UI and change nothing at runtime. A dial
--      that lies in that direction is worse than one that is merely hidden.
--
-- Both bodies reproduced from the LIVE definitions (mig 377), single-hit
-- anchors (mig 430).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.de_trust_surface_candidates(p_tenant_id uuid, p_de_id uuid)
 RETURNS TABLE(capability_key text, kind text, label text, category text, dialable boolean, destructive boolean, uses_confidence boolean, uses_amount boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH me AS (
  SELECT d.id FROM digital_employees d
   WHERE d.id = p_de_id AND d.tenant_id = p_tenant_id
),
-- widget-ask's own eligibility filter, mirrored exactly.
eligible AS (
  SELECT d.id, d.external_reply_mode, d.created_at
    FROM digital_employees d
   WHERE d.tenant_id = p_tenant_id
     AND coalesce(d.lifecycle_status, '') NOT IN ('paused', 'retired', 'archived', 'designed')
),
front AS (  -- the front-DE heuristic: oldest auto-reply DE, else oldest eligible
  SELECT e.id FROM eligible e
   ORDER BY (CASE WHEN e.external_reply_mode = 'auto' THEN 0 ELSE 1 END), e.created_at ASC
   LIMIT 1
),
serves_widget AS (
  SELECT (
    EXISTS (SELECT 1 FROM eligible e WHERE e.id = p_de_id)
    AND (
      EXISTS (SELECT 1 FROM widget_keys wk           -- mig 323: explicit binding wins
               WHERE wk.tenant_id = p_tenant_id AND wk.active AND wk.de_id = p_de_id)
      OR (
        EXISTS (SELECT 1 FROM widget_keys wk         -- a key that falls back to the heuristic
                 WHERE wk.tenant_id = p_tenant_id AND wk.active
                   AND (wk.de_id IS NULL
                        OR NOT EXISTS (SELECT 1 FROM eligible e2 WHERE e2.id = wk.de_id)))
        AND (SELECT f.id FROM front f) = p_de_id
      )
    )
  ) AS yes
),
-- Reachable registered actions: connector-hub's resolveActionDefinition,
-- mirrored (see header for why provider match is not additionally required).
reachable AS (
  SELECT ad.category   AS category,
         ad.action_key AS action_key,
         min(ad.label) AS label,
         bool_or(coalesce((ad.risk ->> 'destructive')::boolean, true)) AS destructive
    FROM action_definitions ad
   WHERE ad.status = 'active'
     AND ad.provider <> 'internal'
     AND (ad.scope = 'platform' OR (ad.scope = 'tenant' AND ad.tenant_id = p_tenant_id))
     AND EXISTS (SELECT 1 FROM connectors c
                  WHERE c.tenant_id = p_tenant_id
                    AND c.status = 'connected'
                    AND c.category = ad.category)
   GROUP BY ad.category, ad.action_key
),
runs_invoice_playbook AS (
  SELECT EXISTS (
    SELECT 1 FROM playbook_definitions pd
     WHERE pd.tenant_id = p_tenant_id
       AND pd.de_id = p_de_id
       AND pd.status = 'published'
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(pd.steps) s
                    WHERE s ->> 'key' = 'generate_invoice')
  ) AS yes
)
SELECT 'answer_dock', 'answer', 'Answers in the dock (internal chat)',
       NULL::text, true, false, true, false
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
SELECT 'answer_widget', 'answer', 'Answers customers on the public widget & help centre',
       NULL::text, true, false, true, false
 WHERE (SELECT yes FROM serves_widget)
UNION ALL
SELECT 'invoice_auto_send', 'playbook', 'Auto-sends renewal invoices (renewal playbook)',
       NULL::text, true, false, false, true
 WHERE EXISTS (SELECT 1 FROM me) AND (SELECT yes FROM runs_invoice_playbook)
UNION ALL
-- A category is dial-able only while it holds at least one non-destructive
-- action: destructive actions gate above the dial unconditionally, so a dial
-- over an all-destructive category could never do anything — showing it
-- dial-able would oversell. The moment a non-destructive action is registered
-- in the category, this recomputes and the dial appears (measured live:
-- the self-management category is all-destructive by design).
SELECT 'action:' || rc.category, 'action_category',
       initcap(replace(rc.category, '_', ' ')) || ' actions',
       rc.category, rc.has_dialable, false, false, true
  FROM (SELECT r.category, bool_or(NOT r.destructive) AS has_dialable
          FROM reachable r GROUP BY r.category) rc
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
SELECT r.action_key, 'action', r.label, r.category,
       NOT r.destructive, r.destructive, false, true
  FROM reachable r
 WHERE EXISTS (SELECT 1 FROM me)
UNION ALL
-- RECORD WRITE-BACKS (mig 496). These are the ops an employee uses to keep its
-- own records current — log an activity, set a next step — and they are NOT
-- registered actions: they are their own RPC family, so the reachable CTE above
-- can never produce a card for them. Before this branch the dial that actually
-- governs them (action_execute + source_category) was invisible on every screen
-- in the product and could not be switched off from anywhere.
--
-- Emitted only for an employee that actually works records: it holds a case
-- whose entity kind has a write-back family, or a system it may write to.
-- dialable = true because the non-destructive ops (log_activity, set_next_step)
-- genuinely reach the dial; the destructive ones (advance_stage, update_status,
-- update_stage) return at the destructive floor above it regardless.
SELECT 'writeback:' || wb.category, 'writeback',
       CASE wb.category WHEN 'crm' THEN 'Keeps its own records current (notes & next steps)'
                        ELSE 'Keeps billing records current (notes & next steps)' END,
       wb.category, true, false, false, false
  FROM (
    SELECT DISTINCT CASE WHEN s.write_registry = 'invoice' THEN 'billing' ELSE 'crm' END AS category
      FROM de_connected_systems s
     WHERE s.de_id = p_de_id AND coalesce(s.can_write, false)
    UNION
    SELECT 'crm' WHERE EXISTS (
      SELECT 1 FROM de_objectives o
       WHERE o.de_id = p_de_id AND o.tenant_id = p_tenant_id
         AND o.entity_kind IN ('customer_account', 'opportunity', 'commercial_agreement'))
  ) wb
 WHERE EXISTS (SELECT 1 FROM me);
$function$
;

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
                     -- mig 496: a write-back card must read the key the GATE
                     -- reads. resolve_de_autonomy_chain stops at the first
                     -- action_type that has ANY row for the tenant, and
                     -- provisioning guarantees 'action_execute' rows exist
                     -- everywhere — so an 'action:crm'-shaped row would be
                     -- silently ignored at runtime while reading as ON here.
                     -- That inverse failure (a dial that looks on and does
                     -- nothing) is worse than the invisible one it replaces.
                     WHEN c.kind = 'writeback' THEN
                       (SELECT to_jsonb(r)
                          FROM resolve_de_autonomy(v_tenant, 'action_execute', p_de_id, c.category) r)
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

notify pgrst, 'reload schema';

do $a$
declare
  v_tenant uuid;
  v_de uuid;
  n int;
begin
  if pg_get_functiondef('public.de_trust_surface_candidates(uuid,uuid)'::regprocedure) not ilike '%writeback:%' then
    raise exception '496: the write-back card was not added';
  end if;
  if pg_get_functiondef('public.list_de_trust_surface(uuid)'::regprocedure) not ilike '%action_execute%' then
    raise exception '496: the surface still reads a different key from the gate';
  end if;

  select t.id into v_tenant from tenants t where t.slug = 'outsourcetel-hq';
  select d.id into v_de from digital_employees d
    where d.tenant_id = v_tenant and d.archetype_key = 'renewal_manager' limit 1;
  if v_tenant is null or v_de is null then
    raise notice '496: no renewal employee fixture — behavioural proof SKIPPED';
    return;
  end if;

  -- BEHAVIOURAL: the renewal employee works commercial_agreement cases, so a
  -- write-back card MUST now appear for it. Before this migration its surface
  -- had seven entries and not one of them was about records.
  select count(*) into n from de_trust_surface_candidates(v_tenant, v_de) c
   where c.kind = 'writeback';
  if n = 0 then
    raise exception '496: the renewal employee still has no record-writing card — the dial stays invisible';
  end if;
  raise notice '496: % write-back card(s) now visible for the renewal employee, reading the same key the gate enforces', n;
end $a$;
