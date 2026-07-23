-- ═══════════════════════════════════════════════════════════════
-- 270 — T1.3: designate a supervisor DE so de-orchestrate routing goes live.
--
-- de-orchestrate (a real supervisor-router that picks the best teammate by
-- responsibility and has them answer on the same thread) had zero callers and
-- no way to name a supervisor. This adds a per-tenant is_supervisor flag +
-- an admin-gated setter; the frontend askDE routes through de-orchestrate,
-- which resolves this flag. No supervisor set → de-orchestrate is a pass-through
-- to de-answer (zero behavior change), so this is safe-by-default.
-- ═══════════════════════════════════════════════════════════════

alter table digital_employees add column if not exists is_supervisor boolean not null default false;

-- At most one supervisor per tenant (hard backstop; the setter also clears first).
create unique index if not exists uq_de_one_supervisor_per_tenant
  on digital_employees (tenant_id) where is_supervisor;

create or replace function public.set_de_supervisor(p_de_id uuid, p_enable boolean)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'digital employee not found'; end if;
  if not (public.is_platform_admin()
          or (v_tenant = public.auth_tenant_id()
              and public.auth_has_tenant_role(array['tenant_owner','tenant_admin']))) then
    raise exception 'only a workspace owner/admin can designate a supervisor';
  end if;
  if p_enable then
    -- Clear the current supervisor first (the partial unique index would
    -- otherwise reject a second true row), then set this one.
    update digital_employees set is_supervisor = false
     where tenant_id = v_tenant and is_supervisor and id <> p_de_id;
    update digital_employees set is_supervisor = true where id = p_de_id;
  else
    update digital_employees set is_supervisor = false where id = p_de_id;
  end if;
end;
$function$;
grant execute on function public.set_de_supervisor(uuid, boolean) to authenticated;

NOTIFY pgrst, 'reload schema';
