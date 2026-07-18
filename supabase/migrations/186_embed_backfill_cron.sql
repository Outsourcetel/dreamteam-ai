-- ═══════════════════════════════════════════════════════════════
-- 186 — continuous embedding backfill (fixes gap G4)
--
-- ingest-chunks embeds gte-small in the edge runtime and can only embed a
-- few chunks per invocation before hitting the worker's memory/CPU cap, so
-- large docs land with most chunks unembedded (null embedding → keyword-only
-- retrieval, silently degrading semantic search). This cron calls the
-- embed-backfill worker on a small batch every 2 minutes; it drains the
-- backlog over time and then no-ops once every chunk is embedded.
-- ═══════════════════════════════════════════════════════════════

create or replace function invoke_embed_backfill()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_req_id bigint;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'playbook_dispatch_secret'
  limit 1;
  if v_secret is null then
    return 'no_secret';
  end if;

  select net.http_post(
    url     := 'https://rfsvmhcqeiyrxivbmpel.supabase.co/functions/v1/embed-backfill',
    body    := jsonb_build_object('limit', 8),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', v_secret),
    timeout_milliseconds := 120000
  ) into v_req_id;

  return 'dispatched:' || v_req_id;
end;
$$;
revoke all on function invoke_embed_backfill() from public, anon, authenticated;
grant execute on function invoke_embed_backfill() to service_role;

-- Every 2 minutes. cron.schedule upserts by job name — idempotent.
select cron.schedule('embed-backfill-drain', '*/2 * * * *', 'select invoke_embed_backfill()');

-- Visibility: per-tenant embedding coverage so Knowledge Quality can show
-- "N% of knowledge is semantically searchable" instead of silently degrading.
create or replace function public.get_embedding_coverage(p_tenant_id uuid)
returns table (total_chunks bigint, embedded_chunks bigint, coverage_pct numeric)
language sql stable security definer set search_path to 'public' as $function$
  select count(c.*) as total_chunks,
         count(c.*) filter (where c.embedding is not null) as embedded_chunks,
         case when count(c.*) = 0 then 100
              else round(100.0 * count(c.*) filter (where c.embedding is not null) / count(c.*), 1)
         end as coverage_pct
  from knowledge_doc_chunks c
  join knowledge_docs kd on kd.id = c.doc_id
  where kd.tenant_id = p_tenant_id
    and (auth.uid() is null or exists (
      select 1 from profiles p where p.user_id = auth.uid()
        and (p.layer = 'platform' or p.tenant_id = p_tenant_id)));
$function$;
revoke all on function public.get_embedding_coverage(uuid) from public, anon;
grant execute on function public.get_embedding_coverage(uuid) to authenticated, service_role;
