-- ============================================================
-- Migration 099: fixes 3 real, currently-exploitable bugs found in
-- the 2026-07-08 go-live readiness re-review (see project memory
-- project_golive_readiness_review_v2 for the full writeup).
--
-- 1. Connector base_url SSRF + credential exfiltration — a tenant's
--    own connector setup (Zendesk/Salesforce/Jira/generic REST/etc.)
--    has a free-text URL field with no validation. It's fetched
--    server-side by connector-hub/connector-zendesk, which attach the
--    connector's own stored credential as an Authorization header —
--    so pointing it at an attacker-controlled host exfiltrates that
--    credential, and/or lets a tenant probe internal infrastructure.
--    Fixed here with a DB-level constraint (is_safe_external_url);
--    the matching edge-function-side check ships in the same commit
--    as a companion TypeScript module (defense in depth — this
--    catches any direct-insert path, the edge function check catches
--    anything that slips past the DB layer, e.g. a future admin tool).
--
-- 2. upsert_action_definition cross-tenant overwrite — migration 056
--    added an explicit check that an existing row (matched by
--    caller-supplied p_id) actually belongs to p_tenant_id before
--    allowing an update. Migration 059's mechanical is_active sweep
--    silently dropped that check while adding is_active — verified by
--    reading the current live function body directly. Restored here.
--
-- 3. Legacy "platform admin manages all X" bypass on conversations/
--    messages/knowledge_articles/agent_actions — predates the
--    audited Remote Access system (052+), gated purely on
--    layer='platform' (any platform role) with zero tenant scope and
--    zero audit trail. conversations/messages are NOT dead tables —
--    confirmed live that the portal chat widget actively writes to
--    them (src/lib/api.ts createConversation/addMessage). Dropped
--    here: verified every one of these 4 tables already has its own
--    proper tenant_id = auth_tenant_id() policy, and auth_tenant_id()
--    itself already has a remote-access-session fallback branch — so
--    a platform admin's legitimate access during an actual audited
--    Remote Access session is preserved automatically; only the
--    always-on, session-free, unaudited bypass is removed.
-- ============================================================

-- ------------------------------------------------------------
-- Fix 1: connector base_url SSRF / credential-exfiltration guard.
-- Blocks loopback, RFC1918 private ranges, link-local (incl. the
-- 169.254.169.254 cloud metadata address), and requires http(s)://.
-- Not a substitute for re-resolving DNS at fetch time (out of scope
-- for this pass — see memory writeup) but closes the direct,
-- literal-address case the finding describes.
-- ------------------------------------------------------------
create or replace function public.is_safe_external_url(p_url text)
returns boolean
language plpgsql
immutable
as $function$
declare
  v_rest text;
  v_host text;
begin
  if p_url is null or btrim(p_url) = '' then
    return false;
  end if;
  if p_url !~* '^https?://[^/]' then
    return false;
  end if;

  v_rest := regexp_replace(p_url, '^https?://', '', 'i');
  if position('@' in split_part(v_rest, '/', 1)) > 0 then
    v_rest := regexp_replace(v_rest, '^[^/@]*@', '');
  end if;
  v_host := lower(split_part(v_rest, '/', 1));
  v_host := split_part(v_host, '?', 1);
  v_host := split_part(v_host, '#', 1);
  v_host := regexp_replace(v_host, '^\[(.*)\]$', '\1');
  if v_host !~ ':.*:' then
    v_host := split_part(v_host, ':', 1);
  end if;

  if v_host = '' then return false; end if;
  if v_host = 'localhost' or v_host = 'localhost.localdomain' then return false; end if;
  if v_host ~ '^127\.' then return false; end if;
  if v_host = '0.0.0.0' or v_host ~ '^0\.' then return false; end if;
  if v_host ~ '^10\.' then return false; end if;
  if v_host ~ '^172\.(1[6-9]|2[0-9]|3[0-1])\.' then return false; end if;
  if v_host ~ '^192\.168\.' then return false; end if;
  if v_host ~ '^169\.254\.' then return false; end if;
  if v_host = '::1' then return false; end if;
  if v_host ~ '^fe80' then return false; end if;
  if v_host ~ '^f[cd][0-9a-f][0-9a-f]:' then return false; end if;

  return true;
end;
$function$;

alter table connectors drop constraint if exists connectors_base_url_safe_check;
alter table connectors add constraint connectors_base_url_safe_check check (is_safe_external_url(base_url));

-- ------------------------------------------------------------
-- Fix 2: restore the cross-tenant ownership check on
-- upsert_action_definition, dropped by migration 059's mechanical
-- sweep. Body otherwise byte-identical to the current (059) live
-- definition; only the new v_existing_tenant check is added, in the
-- same place migration 056 originally put it.
-- ------------------------------------------------------------
create or replace function public.upsert_action_definition(p_id uuid, p_scope text, p_tenant_id uuid, p_category text, p_action_key text, p_label text, p_description text, p_provider text, p_template_id uuid, p_param_schema jsonb, p_risk jsonb, p_execution jsonb)
returns action_definitions
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row action_definitions;
  v_user uuid := auth.uid();
  v_role text;
  v_is_active boolean;
  v_tenant_check uuid;
  v_existing_tenant uuid;
begin
  if p_scope not in ('platform', 'tenant') then
    raise exception 'scope must be platform or tenant';
  end if;
  if p_scope = 'tenant' and p_tenant_id is null then
    raise exception 'tenant scope requires tenant_id';
  end if;
  if p_scope = 'platform' and p_tenant_id is not null then
    raise exception 'platform scope must not carry a tenant_id';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if p_scope = 'platform' then
      raise exception 'only the platform (service role) can define platform-scope actions';
    end if;
    select tenant_id, role, coalesce(is_active, true) into v_tenant_check, v_role, v_is_active from profiles where user_id = v_user;
    if v_tenant_check is distinct from p_tenant_id then
      raise exception 'not a member of this tenant';
    end if;
    if not v_is_active then
      raise exception 'account is deactivated';
    end if;
    if v_role not in ('tenant_owner', 'tenant_admin') then
      raise exception 'only workspace owners/admins can register actions';
    end if;

    -- Restored (dropped by 059): the row named by p_id, if it already
    -- exists, must actually belong to p_tenant_id — otherwise a
    -- caller could pass another tenant's known/guessed id alongside
    -- their own tenant_id and silently overwrite that tenant's action
    -- definition (including its destructive/idempotent risk flags).
    if p_id is not null then
      select tenant_id into v_existing_tenant from action_definitions where id = p_id;
      if found and v_existing_tenant is distinct from p_tenant_id then
        raise exception 'not authorized to modify this action definition';
      end if;
    end if;
  end if;

  if p_provider = 'template' and p_template_id is null then
    raise exception 'template provider requires template_id';
  end if;
  if not (p_risk ? 'destructive') or not (p_risk ? 'idempotent') then
    raise exception 'risk must include destructive and idempotent booleans';
  end if;

  insert into action_definitions (
    id, scope, tenant_id, category, action_key, label, description,
    provider, template_id, param_schema, risk, execution, created_by
  ) values (
    coalesce(p_id, gen_random_uuid()), p_scope, p_tenant_id, p_category, p_action_key, p_label, p_description,
    p_provider, p_template_id, coalesce(p_param_schema, '[]'::jsonb), p_risk, coalesce(p_execution, '{}'::jsonb), v_user
  )
  on conflict (id) do update set
    category = excluded.category, action_key = excluded.action_key,
    label = excluded.label, description = excluded.description,
    provider = excluded.provider, template_id = excluded.template_id,
    param_schema = excluded.param_schema, risk = excluded.risk,
    execution = excluded.execution, updated_at = now()
  returning * into v_row;

  return v_row;
end;
$function$;

-- ------------------------------------------------------------
-- Fix 3: drop the 4 legacy platform-admin bypass policies. Every one
-- of these tables already has its own tenant_id = auth_tenant_id()
-- policy, and auth_tenant_id() already resolves correctly for a
-- platform admin with an active, audited Remote Access session (its
-- second branch) — so legitimate access is unaffected. Only the
-- always-on, unaudited, layer='platform'-only shortcut is removed.
-- ------------------------------------------------------------
drop policy if exists "Platform admins manage all conversations" on conversations;
drop policy if exists "Platform admins manage all messages" on messages;
drop policy if exists "Platform admins manage all articles" on knowledge_articles;
drop policy if exists "Platform admins manage all agent actions" on agent_actions;
