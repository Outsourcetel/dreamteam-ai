-- ═══════════════════════════════════════════════════════════════
-- 272 — T2.1: generic, whitelisted watch-source registry (docs/22)
--
-- run_work_watchers watched only customer_accounts (+ opportunities /
-- commercial_agreements via bespoke branches). This adds a platform-owned,
-- tenant-unwritable CATALOG of watchable sources + a generic evaluator so any
-- role can watch its own domain (finance→renewal_invoices, support→tickets/
-- conversations) by config alone — no runner code per source.
--
-- SAFETY (adversary-reviewed): the 3 legacy bespoke branches are reproduced
-- BYTE-FOR-BYTE from the live definition (they carry quirks like the
-- continuity_cases facet). The generic arms interpolate ONLY catalog-sourced,
-- %I-quoted identifiers (catalog has no tenant write path) + a fixed operator
-- whitelist (sql_op); every value is USING-bound; numerics regex-gated at save.
-- Each per-watcher dispatch runs in its OWN subtransaction, so one bad watcher
-- is skipped + logged, never aborting the GLOBAL cron tick for other tenants.
-- Slice 1 = SQL-only (require_domain_grant defaults OFF everywhere — the grant
-- guard is present but dormant; no archetype re-stamp; no de-work edit).
-- ═══════════════════════════════════════════════════════════════

-- ── §1 Catalog (platform-owned; tenants read, never write) ──
CREATE TABLE IF NOT EXISTS watch_source_catalog (
  source_key       text PRIMARY KEY,
  entity_kind      text NOT NULL,
  domain_category  text NOT NULL
                     CHECK (domain_category IN ('crm','helpdesk','knowledge_base','erp_financials',
                                                'billing','payroll_hcm','pos','product_system','other')),
  table_name       text NOT NULL,
  id_column        text NOT NULL DEFAULT 'id',
  tenant_column    text NOT NULL DEFAULT 'tenant_id',
  label_columns    text[] NOT NULL DEFAULT '{}',
  status_column    text,
  base_predicates  jsonb NOT NULL DEFAULT '[]',
  subject_columns  text[] NOT NULL DEFAULT '{}',
  supports_kinds   text[] NOT NULL,
  require_domain_grant boolean NOT NULL DEFAULT false,
  legacy_bespoke   boolean NOT NULL DEFAULT false,
  default_horizons jsonb NOT NULL DEFAULT '[90,60,30]',
  active           boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS watch_source_fields (
  source_key   text NOT NULL REFERENCES watch_source_catalog(source_key) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('date','state')),
  column_name  text NOT NULL,
  value_type   text CHECK (value_type IN ('numeric','text','date')),
  allowed_ops  text[] NOT NULL DEFAULT '{}',
  label        text NOT NULL DEFAULT '',
  PRIMARY KEY (source_key, role, column_name)
);
ALTER TABLE watch_source_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_source_fields  ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watch_source_catalog_read ON watch_source_catalog;
CREATE POLICY watch_source_catalog_read ON watch_source_catalog FOR SELECT USING (true);
DROP POLICY IF EXISTS watch_source_fields_read ON watch_source_fields;
CREATE POLICY watch_source_fields_read ON watch_source_fields FOR SELECT USING (true);

-- Seed all six sources (require_domain_grant=false on all — grant guard dormant in v1).
INSERT INTO watch_source_catalog
  (source_key, entity_kind, domain_category, table_name, label_columns, status_column,
   base_predicates, subject_columns, supports_kinds, require_domain_grant, legacy_bespoke, default_horizons)
VALUES
 ('customer_accounts','customer_account','crm','customer_accounts','{name}','status',
   '[]','{name,renewal_date,arr_cents,health_score,status,tier}',
   ARRAY['date_horizon','state_condition'], false, true, '[90,60,30]'),
 ('opportunities','opportunity','crm','opportunities','{name,company_name}','stage',
   '[{"col":"closed_at","op":"is_null"}]','{name,close_date,amount_cents,stage}',
   ARRAY['date_horizon','state_condition'], false, true, '[30,14,7]'),
 ('commercial_agreements','commercial_agreement','crm','commercial_agreements','{counterparty_name,title}','status',
   '[]','{counterparty_name,agreement_type,party_side,baseline_value_cents}',
   ARRAY['date_horizon'], false, true, '[90,60,30]'),
 ('renewal_invoices','renewal_invoice','billing','renewal_invoices','{}','status',
   '[]','{amount_cents,status,due_date,account_id,cadence_stage}',
   ARRAY['date_horizon','state_condition'], false, false, '[14,7,1]'),
 ('support_tickets','support_ticket','helpdesk','support_tickets','{subject}','status',
   '[]','{subject,status,priority,assignee}',
   ARRAY['state_condition'], false, false, '[90,60,30]'),
 ('de_conversations','de_conversation','helpdesk','de_conversations','{subject}','status',
   '[]','{subject,status,priority,channel}',
   ARRAY['state_condition'], false, false, '[90,60,30]')
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO watch_source_fields (source_key, role, column_name, value_type, allowed_ops, label) VALUES
 ('customer_accounts','date','renewal_date','date','{}','Renewal date'),
 ('customer_accounts','state','health_score','numeric','{lt,lte,gt,gte,eq,neq}','Health score'),
 ('customer_accounts','state','arr_cents','numeric','{lt,lte,gt,gte,eq,neq}','ARR (cents)'),
 ('customer_accounts','state','status','text','{eq,neq}','Status'),
 ('customer_accounts','state','tier','text','{eq,neq}','Tier'),
 ('opportunities','date','close_date','date','{}','Close date'),
 ('opportunities','state','stage','text','{eq,neq}','Stage'),
 ('opportunities','state','amount_cents','numeric','{lt,lte,gt,gte,eq,neq}','Amount (cents)'),
 ('commercial_agreements','date','renewal_date','date','{}','Renewal date'),
 ('commercial_agreements','date','notice_deadline','date','{}','Notice deadline'),
 ('commercial_agreements','date','warranty_expiry','date','{}','Warranty expiry'),
 ('commercial_agreements','date','next_reorder_date','date','{}','Next reorder'),
 ('commercial_agreements','date','cancellation_deadline','date','{}','Cancellation deadline'),
 ('commercial_agreements','date','pricing_notice_deadline','date','{}','Pricing notice deadline'),
 ('commercial_agreements','date','replacement_date','date','{}','Replacement date'),
 ('renewal_invoices','date','due_date','date','{}','Due date'),
 ('renewal_invoices','state','status','text','{eq,neq}','Invoice status'),
 ('renewal_invoices','state','amount_cents','numeric','{lt,lte,gt,gte,eq,neq}','Amount (cents)'),
 ('support_tickets','state','status','text','{eq,neq}','Ticket status'),
 ('support_tickets','state','priority','text','{eq,neq}','Priority'),
 ('support_tickets','state','assignee','text','{eq,neq}','Assignee'),
 ('de_conversations','state','status','text','{eq,neq}','Conversation status'),
 ('de_conversations','state','priority','text','{eq,neq}','Priority')
ON CONFLICT DO NOTHING;

-- ── §3c Safe-dynamic-SQL helpers ──
CREATE OR REPLACE FUNCTION public.sql_op(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'lt' THEN '<' WHEN 'lte' THEN '<=' WHEN 'gt' THEN '>'
               WHEN 'gte' THEN '>=' WHEN 'eq' THEN '=' WHEN 'neq' THEN '<>'
               ELSE '=' END $$;

CREATE OR REPLACE FUNCTION public.build_base_predicates(p jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE e jsonb; out text := ''; BEGIN
  FOR e IN SELECT jsonb_array_elements(coalesce(p,'[]'::jsonb)) LOOP
    out := out || CASE e->>'op'
      WHEN 'is_null'         THEN format(' AND %I IS NULL', e->>'col')
      WHEN 'is_not_null'     THEN format(' AND %I IS NOT NULL', e->>'col')
      WHEN 'ge_current_date' THEN format(' AND %I >= current_date', e->>'col')
      ELSE '' END;
  END LOOP; RETURN out; END $$;

CREATE OR REPLACE FUNCTION public.watcher_label(cols text[], row_j jsonb, kind text, id text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE c text; BEGIN
  FOREACH c IN ARRAY cols LOOP
    IF nullif(row_j->>c,'') IS NOT NULL THEN RETURN row_j->>c; END IF;
  END LOOP;
  RETURN replace(initcap(replace(kind,'_',' ')),' ','') || ' ' || left(id,8);
END $$;

CREATE OR REPLACE FUNCTION public.jsonb_object_agg_subset(row_j jsonb, cols text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(c, row_j->c) FILTER (WHERE row_j ? c), '{}'::jsonb)
  FROM unnest(cols) AS c $$;

GRANT EXECUTE ON FUNCTION public.sql_op(text), public.build_base_predicates(jsonb),
  public.watcher_label(text[], jsonb, text, text), public.jsonb_object_agg_subset(jsonb, text[]) TO service_role;

-- ── §2 Validator — catalog-driven (grant guard present but dormant in v1) ──
CREATE OR REPLACE FUNCTION public.validate_work_watcher()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  c jsonb := NEW.config;
  src text := coalesce(NEW.config->>'source','customer_accounts');
  s   watch_source_catalog;
  f   watch_source_fields;
  v_op text := coalesce(c->>'op','');
  v_grant_ok boolean;
BEGIN
  IF NEW.kind IN ('date_horizon','state_condition') THEN
    SELECT * INTO s FROM watch_source_catalog WHERE source_key = src AND active;
    IF s.source_key IS NULL THEN
      RAISE EXCEPTION 'unknown watch source "%": not in watch_source_catalog', src;
    END IF;
    IF NOT (NEW.kind = ANY (s.supports_kinds)) THEN
      RAISE EXCEPTION 'source "%" does not support watcher kind %', src, NEW.kind;
    END IF;

    IF NEW.kind = 'date_horizon' THEN
      IF NOT EXISTS (SELECT 1 FROM watch_source_fields
                     WHERE source_key = src AND role = 'date'
                       AND column_name = coalesce(c->>'date_field',
                            (SELECT column_name FROM watch_source_fields
                              WHERE source_key = src AND role='date' ORDER BY column_name LIMIT 1))) THEN
        RAISE EXCEPTION 'date_field "%" is not watchable on source %', c->>'date_field', src;
      END IF;
      IF c ? 'horizons_days' AND jsonb_typeof(c->'horizons_days') <> 'array' THEN
        RAISE EXCEPTION 'horizons_days must be a JSON array';
      END IF;

    ELSIF NEW.kind = 'state_condition' THEN
      SELECT * INTO f FROM watch_source_fields
        WHERE source_key = src AND role = 'state' AND column_name = c->>'field';
      IF f.column_name IS NULL THEN
        RAISE EXCEPTION 'field "%" is not a watchable state column on source %', c->>'field', src;
      END IF;
      IF NOT (v_op = ANY (f.allowed_ops)) THEN
        RAISE EXCEPTION 'op "%" not allowed for %.% (allowed: %)', v_op, src, f.column_name, f.allowed_ops;
      END IF;
      IF c->>'value' IS NULL THEN RAISE EXCEPTION 'state_condition value is required'; END IF;
      IF f.value_type = 'numeric' AND (c->>'value') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RAISE EXCEPTION 'value for numeric field % must be numeric', f.column_name;
      END IF;
    END IF;

    IF s.require_domain_grant THEN
      SELECT EXISTS (SELECT 1 FROM data_access_grants g
                      WHERE g.tenant_id = NEW.tenant_id AND g.subject_kind='de'
                        AND g.subject_id = NEW.de_id
                        AND g.resource_category = s.domain_category)
        INTO v_grant_ok;
      IF NOT v_grant_ok THEN
        RAISE EXCEPTION 'DE % has no % grant; cannot watch source %', NEW.de_id, s.domain_category, src;
      END IF;
    END IF;

  ELSIF NEW.kind = 'metric_threshold' THEN
    IF c->>'metric_key' IS NULL THEN RAISE EXCEPTION 'metric_threshold metric_key is required'; END IF;
    IF NOT (v_op IN ('lt','gt')) THEN RAISE EXCEPTION 'metric_threshold op must be lt|gt'; END IF;
    IF c->>'value' IS NULL THEN RAISE EXCEPTION 'metric_threshold value is required'; END IF;
  ELSIF NEW.kind = 'schedule' THEN
    IF coalesce((c->>'interval_minutes')::int, 0) < 60 THEN RAISE EXCEPTION 'schedule interval_minutes must be >= 60'; END IF;
  END IF;
  RETURN NEW;
END; $$;

-- ── §5 run_work_watchers: legacy body byte-for-byte + generic arms + per-watcher
--     subtransaction isolation. Appended from the transformed live definition. ──
CREATE OR REPLACE FUNCTION public.run_work_watchers(p_tenant_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  w work_watchers; v_new integer; v_total integer := 0; v_watchers integer := 0;
  v_obj_id uuid; v_inserted boolean; r record; v_h integer; v_occ text;
  v_title text; v_de_name text; v_src text; v_date_field text; v_motion text;
  v_cat watch_source_catalog; v_row jsonb; v_id text; v_where text; v_sql text;
  v_field text; v_op text; v_vt text; v_cast text; v_datef text; v_label text; v_subject jsonb; v_cap int;
BEGIN
  FOR w IN SELECT * FROM work_watchers WHERE active AND kind <> 'inbox'
      AND (p_tenant_id IS NULL OR tenant_id = p_tenant_id) ORDER BY created_at
  LOOP
    v_new := 0; v_watchers := v_watchers + 1;
    v_src := coalesce(w.config->>'source','customer_accounts');
    SELECT coalesce(persona_name, name) INTO v_de_name FROM digital_employees WHERE id = w.de_id;

    BEGIN
    -- ── date_horizon ──
    IF w.kind = 'date_horizon' AND v_src = 'customer_accounts' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.renewal_date, ca.arr_cents, ca.health_score,
               (ca.renewal_date - current_date) AS days_left
        FROM customer_accounts ca
        WHERE ca.tenant_id = w.tenant_id AND ca.renewal_date IS NOT NULL AND ca.renewal_date >= current_date
          AND (w.config->'status_filter' IS NULL OR ca.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || r.renewal_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day checkpoint, renews ' || to_char(r.renewal_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' renews on ' || r.renewal_date::text || ' (' || r.days_left || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'customer_account', r.id::text, 'open', v_h, r.renewal_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'renewal_date', r.renewal_date, 'arr_cents', r.arr_cents, 'health_score', r.health_score))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    ELSIF w.kind = 'date_horizon' AND v_src = 'opportunities' THEN
      FOR r IN
        SELECT o.id, coalesce(o.name, o.company_name, 'opportunity') AS name, o.close_date, o.amount_cents, o.stage,
               (o.close_date - current_date) AS days_left
        FROM opportunities o
        WHERE o.tenant_id = w.tenant_id AND o.close_date IS NOT NULL AND o.close_date >= current_date AND o.closed_at IS NULL
          AND (w.config->'stage_filter' IS NULL OR o.stage IN (SELECT jsonb_array_elements_text(w.config->'stage_filter')))
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[30,14,7]'::jsonb)))::int AS h) hs WHERE h >= r.days_left;
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || r.close_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day, closes ' || to_char(r.close_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' is in stage "' || coalesce(r.stage,'?') || '" and closes on ' || r.close_date::text || ' (' || r.days_left || ' days out). Advance it per the playbook.',
          'opportunity', r.id::text, 'open', v_h, r.close_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,
            'subject', jsonb_build_object('name', r.name, 'close_date', r.close_date, 'amount_cents', r.amount_cents, 'stage', r.stage))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── NEW: date_horizon on commercial_agreements (configurable date_field) ──
    -- Opens a de_objectives case AND its typed continuity_cases facet, stamped
    -- with the motion (explicit config override, else derived from the date_field).
    ELSIF w.kind = 'date_horizon' AND v_src = 'commercial_agreements' THEN
      v_date_field := coalesce(w.config->>'date_field','renewal_date');
      FOR r IN
        SELECT sub.* FROM (
          SELECT a.id, coalesce(a.counterparty_name, a.title) AS name, a.account_id, a.party_side,
                 a.baseline_value_cents, a.status, a.agreement_type,
                 (CASE v_date_field
                    WHEN 'renewal_date'            THEN a.renewal_date
                    WHEN 'notice_deadline'         THEN a.notice_deadline
                    WHEN 'warranty_expiry'         THEN a.warranty_expiry
                    WHEN 'next_reorder_date'       THEN a.next_reorder_date
                    WHEN 'cancellation_deadline'   THEN a.cancellation_deadline
                    WHEN 'pricing_notice_deadline' THEN a.pricing_notice_deadline
                    WHEN 'replacement_date'        THEN a.replacement_date
                    ELSE a.renewal_date END) AS target_date
          FROM commercial_agreements a
          WHERE a.tenant_id = w.tenant_id
            AND (w.config->'status_filter' IS NULL OR a.status IN (SELECT jsonb_array_elements_text(w.config->'status_filter')))
        ) sub
        WHERE sub.target_date IS NOT NULL AND sub.target_date >= current_date
      LOOP
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days','[90,60,30]'::jsonb)))::int AS h) hs WHERE h >= (r.target_date - current_date);
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := r.id::text || '|' || v_date_field || '|' || r.target_date::text || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;

        v_motion := coalesce(nullif(w.config->>'motion',''),
          CASE v_date_field
            WHEN 'renewal_date'            THEN 'renew'
            WHEN 'notice_deadline'         THEN 'renew'
            WHEN 'warranty_expiry'         THEN 'replace'
            WHEN 'next_reorder_date'       THEN 'reorder'
            WHEN 'replacement_date'        THEN 'replace'
            WHEN 'cancellation_deadline'   THEN 'renew'
            WHEN 'pricing_notice_deadline' THEN 'renegotiate'
            ELSE 'renew' END);

        v_title := w.label || ' — ' || r.name || ' (' || v_h || '-day, ' || v_date_field || ' ' || to_char(r.target_date, 'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' — ' || v_motion || ' motion. The ' || replace(v_date_field,'_',' ')
            || ' is ' || r.target_date::text || ' (' || (r.target_date - current_date) || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          'commercial_agreement', r.id::text, 'open', v_h, r.target_date::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'horizon_days',v_h,'motion',v_motion,'date_field',v_date_field,
            'subject', jsonb_build_object('name', r.name, 'agreement_type', r.agreement_type, 'party_side', r.party_side,
              'target_date', r.target_date, 'baseline_value_cents', r.baseline_value_cents))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;

        -- The typed facet: exactly one per case, driven off the SAME objective.
        INSERT INTO continuity_cases (objective_id, tenant_id, de_id, agreement_id, account_id, motion, stage_key, party_side, baseline_cents)
        VALUES (v_obj_id, w.tenant_id, w.de_id, r.id, r.account_id, v_motion, 'discovered', coalesce(r.party_side,'sell'), r.baseline_value_cents)
        ON CONFLICT (objective_id) DO NOTHING;
        INSERT INTO continuity_case_events (tenant_id, objective_id, to_stage, motion, actor_kind, summary, detail)
        VALUES (w.tenant_id, v_obj_id, 'discovered', v_motion, 'system',
          'Case opened by Book of Work — ' || v_motion || ' on ' || r.name || ' (' || replace(v_date_field,'_',' ') || ')',
          jsonb_build_object('watcher_id', w.id, 'date_field', v_date_field, 'horizon_days', v_h));
        v_new := v_new + 1;
      END LOOP;


    -- GENERIC date_horizon (catalog-driven; any non-legacy source)
    ELSIF w.kind = 'date_horizon' THEN
      SELECT * INTO v_cat FROM watch_source_catalog WHERE source_key = v_src AND active AND NOT legacy_bespoke;
      IF v_cat.source_key IS NULL THEN CONTINUE; END IF;
      v_datef := coalesce(w.config->>'date_field',
                   (SELECT column_name FROM watch_source_fields WHERE source_key = v_src AND role='date' ORDER BY column_name LIMIT 1));
      IF v_datef IS NULL OR NOT EXISTS (SELECT 1 FROM watch_source_fields WHERE source_key=v_src AND role='date' AND column_name=v_datef) THEN CONTINUE; END IF;
      v_cap := least(coalesce((w.config->>'max_per_run')::int, 1000), 1000);
      v_where := format('%I = $1 AND %I IS NOT NULL AND %I >= current_date', v_cat.tenant_column, v_datef, v_datef)
                 || build_base_predicates(v_cat.base_predicates)
                 || format(' AND ($2::text[] IS NULL OR %I = ANY($2))', v_cat.status_column);
      v_sql := format('SELECT %I::text AS _id, to_jsonb(t.*) AS _row FROM %I t WHERE %s ORDER BY %I LIMIT %s',
                      v_cat.id_column, v_cat.table_name, v_where, v_datef, v_cap);
      FOR r IN EXECUTE v_sql USING w.tenant_id,
                 CASE WHEN w.config ? 'status_filter' THEN ARRAY(SELECT jsonb_array_elements_text(w.config->'status_filter')) ELSE NULL::text[] END
      LOOP
        v_row := r._row; v_id := r._id;
        SELECT min(h) INTO v_h FROM (SELECT (jsonb_array_elements_text(coalesce(w.config->'horizons_days', v_cat.default_horizons)))::int AS h) hs WHERE h >= ((v_row->>v_datef)::date - current_date);
        IF v_h IS NULL THEN CONTINUE; END IF;
        v_occ := v_id || '|' || v_datef || '|' || (v_row->>v_datef) || '|' || v_h::text;
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, v_id, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_label := watcher_label(v_cat.label_columns, v_row, v_cat.entity_kind, v_id);
        v_subject := jsonb_object_agg_subset(v_row, v_cat.subject_columns);
        v_title := w.label || ' — ' || v_label || ' (' || v_h || '-day, ' || replace(v_datef,'_',' ') || ' ' || to_char((v_row->>v_datef)::date,'Mon DD') || ')';
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, due_at, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title,200),
          'Opened by the Book of Work: ' || v_label || ' — ' || replace(v_datef,'_',' ') || ' is ' || (v_row->>v_datef) || ' (' || (((v_row->>v_datef)::date - current_date)) || ' days out). Work the ' || v_h || '-day motion per the playbook.',
          v_cat.entity_kind, v_id, 'open', v_h, (v_row->>v_datef)::timestamptz,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'watch_source',v_src,'date_field',v_datef,'horizon_days',v_h,'subject', v_subject))
        RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id=v_obj_id WHERE watcher_id=w.id AND occurrence_key=v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── state_condition ──
    ELSIF w.kind = 'state_condition' AND v_src = 'customer_accounts' THEN
      FOR r IN
        SELECT ca.id, ca.name, ca.health_score, ca.status, ca.arr_cents, ca.tier
        FROM customer_accounts ca WHERE ca.tenant_id = w.tenant_id
          AND CASE w.config->>'field'
                WHEN 'health_score' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN ca.health_score < (w.config->>'value')::numeric WHEN 'lte' THEN ca.health_score <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN ca.health_score > (w.config->>'value')::numeric WHEN 'gte' THEN ca.health_score >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN ca.health_score = (w.config->>'value')::numeric ELSE ca.health_score <> (w.config->>'value')::numeric END
                WHEN 'arr_cents' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN ca.arr_cents < (w.config->>'value')::numeric WHEN 'lte' THEN ca.arr_cents <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN ca.arr_cents > (w.config->>'value')::numeric WHEN 'gte' THEN ca.arr_cents >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN ca.arr_cents = (w.config->>'value')::numeric ELSE ca.arr_cents <> (w.config->>'value')::numeric END
                WHEN 'status' THEN CASE w.config->>'op' WHEN 'eq' THEN ca.status = w.config->>'value' ELSE ca.status <> w.config->>'value' END
                WHEN 'tier' THEN CASE w.config->>'op' WHEN 'eq' THEN ca.tier = w.config->>'value' ELSE ca.tier <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          'customer_account', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'health_score', r.health_score, 'status', r.status))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;

    ELSIF w.kind = 'state_condition' AND v_src = 'opportunities' THEN
      FOR r IN
        SELECT o.id, coalesce(o.name, o.company_name, 'opportunity') AS name, o.stage, o.amount_cents, o.close_date
        FROM opportunities o WHERE o.tenant_id = w.tenant_id AND o.closed_at IS NULL
          AND CASE w.config->>'field'
                WHEN 'amount_cents' THEN CASE w.config->>'op'
                    WHEN 'lt' THEN o.amount_cents < (w.config->>'value')::numeric WHEN 'lte' THEN o.amount_cents <= (w.config->>'value')::numeric
                    WHEN 'gt' THEN o.amount_cents > (w.config->>'value')::numeric WHEN 'gte' THEN o.amount_cents >= (w.config->>'value')::numeric
                    WHEN 'eq' THEN o.amount_cents = (w.config->>'value')::numeric ELSE o.amount_cents <> (w.config->>'value')::numeric END
                WHEN 'stage' THEN CASE w.config->>'op' WHEN 'eq' THEN o.stage = w.config->>'value' ELSE o.stage <> w.config->>'value' END
                ELSE false END
      LOOP
        v_occ := r.id::text || '|' || (w.config->>'field') || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.id::text, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_title := w.label || ' — ' || r.name;
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(v_title, 200),
          'Opened by the Book of Work: opportunity ' || r.name || ' matched "' || (w.config->>'field') || ' ' || (w.config->>'op') || ' ' || (w.config->>'value') || '". Advance it per the playbook.',
          'opportunity', r.id::text, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'condition', w.config,
            'subject', jsonb_build_object('name', r.name, 'stage', r.stage, 'amount_cents', r.amount_cents, 'close_date', r.close_date))
        ) RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
        v_new := v_new + 1;
      END LOOP;


    -- GENERIC state_condition (catalog-driven; any non-legacy source)
    ELSIF w.kind = 'state_condition' THEN
      SELECT * INTO v_cat FROM watch_source_catalog WHERE source_key = v_src AND active AND NOT legacy_bespoke;
      IF v_cat.source_key IS NULL THEN CONTINUE; END IF;
      v_field := w.config->>'field'; v_op := w.config->>'op';
      SELECT value_type INTO v_vt FROM watch_source_fields WHERE source_key=v_src AND role='state' AND column_name=v_field AND v_op = ANY (allowed_ops);
      IF v_vt IS NULL THEN CONTINUE; END IF;
      v_cast := CASE WHEN v_vt = 'numeric' THEN '::numeric' ELSE '' END;
      v_where := format('%I = $1', v_cat.tenant_column) || build_base_predicates(v_cat.base_predicates)
                 || format(' AND %I %s $2%s', v_field, sql_op(v_op), v_cast)
                 || format(' AND NOT EXISTS (SELECT 1 FROM work_watcher_matches m WHERE m.watcher_id = $3 AND m.subject_ref = t.%I::text)', v_cat.id_column);
      v_sql := format('SELECT %I::text AS _id, to_jsonb(t.*) AS _row FROM %I t WHERE %s', v_cat.id_column, v_cat.table_name, v_where);
      FOR r IN EXECUTE v_sql USING w.tenant_id, (w.config->>'value'), w.id
      LOOP
        v_row := r._row; v_id := r._id;
        v_occ := v_id || '|' || v_field || v_op || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, v_id, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT; IF NOT v_inserted THEN CONTINUE; END IF;
        v_label := watcher_label(v_cat.label_columns, v_row, v_cat.entity_kind, v_id);
        v_subject := jsonb_object_agg_subset(v_row, v_cat.subject_columns);
        INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
        VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || v_label,200),
          'Opened by the Book of Work: ' || v_label || ' matched "' || v_field || ' ' || v_op || ' ' || (w.config->>'value') || '". Assess and work per the playbook.',
          v_cat.entity_kind, v_id, 'open', 2,
          jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'watch_source',v_src,'condition',w.config,'subject', v_subject))
        RETURNING id INTO v_obj_id;
        UPDATE work_watcher_matches SET objective_id=v_obj_id WHERE watcher_id=w.id AND occurrence_key=v_occ;
        v_new := v_new + 1;
      END LOOP;

    -- ── metric_threshold (unchanged from mig 220) ──
    ELSIF w.kind = 'metric_threshold' THEN
      SELECT k.metric_key AS mkey, k.value, k.as_of INTO r
      FROM de_kpi_readings k WHERE k.tenant_id = w.tenant_id AND k.de_id = w.de_id AND k.metric_key = w.config->>'metric_key'
      ORDER BY k.as_of DESC, k.created_at DESC LIMIT 1;
      IF r.mkey IS NOT NULL AND ((w.config->>'op' = 'lt' AND r.value < (w.config->>'value')::numeric) OR (w.config->>'op' = 'gt' AND r.value > (w.config->>'value')::numeric)) THEN
        v_occ := r.mkey || '|' || r.as_of::text || '|' || (w.config->>'op') || (w.config->>'value');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, r.mkey, v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label || ' — ' || r.mkey || ' at ' || r.value, 200),
            'Opened by the Book of Work: metric "' || r.mkey || '" read ' || r.value || ' on ' || r.as_of || ', crossing the ' || (w.config->>'op') || ' ' || (w.config->>'value') || ' line. Investigate per the playbook.',
            'metric', r.mkey, 'open', 2,
            jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'reading', jsonb_build_object('metric_key', r.mkey, 'value', r.value, 'as_of', r.as_of))
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
      END IF;

    -- ── schedule (unchanged from mig 220) ──
    ELSIF w.kind = 'schedule' THEN
      IF w.next_fire_at IS NULL THEN
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      ELSIF now() >= w.next_fire_at THEN
        v_occ := to_char(w.next_fire_at, 'YYYY-MM-DD"T"HH24:MI');
        INSERT INTO work_watcher_matches (tenant_id, watcher_id, subject_ref, occurrence_key)
        VALUES (w.tenant_id, w.id, 'schedule', v_occ) ON CONFLICT (watcher_id, occurrence_key) DO NOTHING;
        GET DIAGNOSTICS v_inserted = ROW_COUNT;
        IF v_inserted THEN
          INSERT INTO de_objectives (tenant_id, de_id, title, description, entity_kind, entity_ref, status, priority, plan)
          VALUES (w.tenant_id, w.de_id, left(w.label, 200),
            'Opened by the Book of Work on schedule (' || coalesce(w.description, w.label) || '). Run the recurring motion per the playbook.',
            'schedule', v_occ, 'open', 3, jsonb_build_object('source','book_of_work','watcher_id',w.id,'kind',w.kind,'fired_at', now())
          ) RETURNING id INTO v_obj_id;
          UPDATE work_watcher_matches SET objective_id = v_obj_id WHERE watcher_id = w.id AND occurrence_key = v_occ;
          v_new := v_new + 1;
        END IF;
        UPDATE work_watchers SET next_fire_at = now() + make_interval(mins => (w.config->>'interval_minutes')::int) WHERE id = w.id;
      END IF;
    END IF;
    EXCEPTION WHEN OTHERS THEN
      BEGIN PERFORM append_audit_event_internal(w.tenant_id, 'system', 'system',
        'Book of Work watcher "' || w.label || '" errored and was skipped this tick', 'playbook_step',
        jsonb_build_object('kind','book_of_work_error','watcher_id', w.id, 'error', SQLERRM));
      EXCEPTION WHEN OTHERS THEN NULL; END;
      CONTINUE;
    END;

    UPDATE work_watchers SET last_run_at = now(), last_match_count = v_new WHERE id = w.id;
    v_total := v_total + v_new;
    IF v_new > 0 THEN
      BEGIN PERFORM append_audit_event_internal(w.tenant_id, coalesce(v_de_name, 'DE'), 'de',
          coalesce(v_de_name, 'DE') || ' found ' || v_new || ' new work item(s) via Book of Work watcher "' || w.label || '"',
          'playbook_step', jsonb_build_object('kind','book_of_work','watcher_id', w.id, 'watcher_kind', w.kind, 'new_cases', v_new));
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'watchers_run', v_watchers, 'cases_opened', v_total);
END; $function$
;

NOTIFY pgrst, 'reload schema';
