-- ═══════════════════════════════════════════════════════════════
-- 174 — MCP server allowlist (Frontier-20 #9, injection-firewall layer)
--
-- MCP supply-chain is the top NEW injection vector of 2026: a malicious
-- or compromised MCP server can feed poisoned tool descriptions and tool
-- results straight into an agent loop. The SSRF guard (mig 154 era)
-- already blocks private-network endpoints; this adds POLICY control:
-- which external hosts a tenant's MCP sources may talk to at all.
--
-- OPT-IN semantics (deliberate): a tenant with NO allowlist rows keeps
-- today's behavior (any public endpoint passing the SSRF guard). The
-- moment a tenant adds one row, mcp-client enforces host ∈ allowlist for
-- that tenant. Opt-in because flipping existing tenants to deny-all
-- would silently break every working MCP source they already trust.
-- ═══════════════════════════════════════════════════════════════

create table if not exists mcp_server_allowlist (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  host       text not null,           -- exact hostname, e.g. mcp.vendor.com
  note       text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, host)
);

alter table mcp_server_allowlist enable row level security;
drop policy if exists mcp_allowlist_read on mcp_server_allowlist;
create policy mcp_allowlist_read on mcp_server_allowlist for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));
drop policy if exists mcp_allowlist_write on mcp_server_allowlist;
create policy mcp_allowlist_write on mcp_server_allowlist for all using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid()
                and p.role in ('tenant_owner', 'tenant_admin')))
  with check (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid()
                and p.role in ('tenant_owner', 'tenant_admin')));

-- Server-side check used by mcp-client (service role): is this host
-- permitted for this tenant? Empty allowlist → permitted (opt-in).
create or replace function public.mcp_host_allowed(p_tenant_id uuid, p_host text)
returns boolean
language sql security definer set search_path to 'public' stable as $function$
  select case
    when not exists (select 1 from mcp_server_allowlist where tenant_id = p_tenant_id)
      then true
    else exists (select 1 from mcp_server_allowlist
                  where tenant_id = p_tenant_id and lower(host) = lower(p_host))
  end;
$function$;
revoke all on function public.mcp_host_allowed(uuid, text) from public, anon;
grant execute on function public.mcp_host_allowed(uuid, text) to authenticated, service_role;
