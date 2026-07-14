-- ============================================================
-- 150 — set_de_external_reply_mode: flip a DE between draft-for-approval
-- and auto-send for external customer replies, from the DE profile UI
-- (instead of SQL). Kept as its own tiny RPC rather than touching the
-- evolved update_digital_employee. Tenant-member gated.
-- ============================================================
create or replace function public.set_de_external_reply_mode(p_de_id uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if p_mode not in ('draft', 'auto') then raise exception 'mode must be draft or auto'; end if;
  select tenant_id into v_tenant from digital_employees where id = p_de_id;
  if v_tenant is null then raise exception 'digital_employee_not_found'; end if;
  if not (is_platform_admin() or exists (select 1 from profiles p where p.user_id = auth.uid() and p.tenant_id = v_tenant)) then
    raise exception 'not authorized for this workspace';
  end if;
  update digital_employees set external_reply_mode = p_mode where id = p_de_id;
end;
$function$;

grant execute on function public.set_de_external_reply_mode(uuid, text) to authenticated;
