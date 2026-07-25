-- 327_set_de_voice.sql
-- ============================================================================
-- Give the voice a human control.
--
-- mig 325 added digital_employees.voice + .context_turns and the answer paths
-- read them. A column no UI can write is the same written-never-read defect in
-- reverse — so this is the writer, mirroring set_de_identity exactly:
-- owner/admin only, tenant-scoped, retired employees locked, audited.
--
-- Deliberately NOT part of de_config_fingerprint: voice governs MANNER, and
-- the certification exam grades FACTS. Folding it in would force a full
-- re-certification every time someone softened a sentence, which would train
-- people to stop tuning it. Grounding changes still invalidate certification
-- exactly as before. GLOBAL.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.set_de_voice(
  p_de_id uuid,
  p_voice text DEFAULT NULL::text,
  p_context_turns int DEFAULT NULL::int
)
RETURNS digital_employees
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid;
  v_row digital_employees;
  v_actor text;
  v_voice text;
begin
  v_tenant := auth_tenant_id();
  if v_tenant is null then raise exception 'not a member of any tenant'; end if;
  if not auth_has_tenant_role(array['tenant_owner', 'tenant_admin']) then
    raise exception 'only workspace owners/admins can edit a Digital Employee''s voice';
  end if;
  select * into v_row from digital_employees where id = p_de_id and tenant_id = v_tenant;
  if v_row.id is null then raise exception 'employee not found in this workspace'; end if;
  if v_row.lifecycle_status in ('retired', 'archived') then
    raise exception 'this employee is retired — configuration is locked read-only';
  end if;

  -- Empty string means "clear it and go back to the house voice"; NULL means
  -- "leave it alone" (so a caller can update turns without touching voice).
  v_voice := case when p_voice is null then v_row.voice
                  when btrim(p_voice) = '' then null
                  else left(btrim(p_voice), 2000) end;

  update digital_employees set
    voice = v_voice,
    -- 0 restores single-turn behaviour; 30 is the ceiling the edge functions
    -- clamp to anyway, enforced here so the stored value never lies.
    context_turns = coalesce(least(greatest(p_context_turns, 0), 30), context_turns),
    config_version = config_version + 1,
    updated_at = now()
  where id = p_de_id
  returning * into v_row;

  select full_name into v_actor from profiles where user_id = auth.uid();
  perform append_audit_event_internal(
    v_tenant, coalesce(v_actor, 'A workspace admin'), 'human',
    format('%s voice updated (tone + conversation memory) — config v%s', v_row.name, v_row.config_version),
    'config_change',
    jsonb_build_object('kind', 'de_voice_update', 'de_id', p_de_id,
                       'config_version', v_row.config_version,
                       'has_custom_voice', v_row.voice is not null,
                       'context_turns', v_row.context_turns)
  );
  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.set_de_voice(uuid, text, int) FROM public;
GRANT EXECUTE ON FUNCTION public.set_de_voice(uuid, text, int) TO authenticated;

NOTIFY pgrst, 'reload schema';
