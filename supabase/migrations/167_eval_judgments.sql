-- ═══════════════════════════════════════════════════════════════
-- 167 — LLM-judge evaluation spine (Frontier-20 #1)
--
-- The existing eval-run scores answers by substring fragment matching
-- (pass = all expected_fragments present) — brittle: a correct paraphrase
-- fails, a wrong answer that happens to contain the fragment passes.
-- This adds SEMANTIC judging: an LLM scores a DE answer on grounding,
-- correctness-vs-reference, guardrail-safety, and tone, with a rationale.
--
-- eval_judgments is the shared record for four Frontier capabilities that
-- all need "is this answer actually good?": continuous online evals (#2),
-- simulation studio (#3), golden-set regression gate (#4), and the
-- verified self-improvement loop (#5). The `source` column tags which.
-- Judging itself runs in the eval-judge edge function (LLM); this is the
-- store + a per-DE rollup RPC.
-- ═══════════════════════════════════════════════════════════════

create table if not exists eval_judgments (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  de_id       uuid references digital_employees(id) on delete set null,
  source      text not null default 'golden'
                check (source in ('golden', 'online', 'simulation', 'regression', 'adhoc')),
  golden_id   uuid,                              -- golden_qa row when source='golden'
  question    text not null,
  answer      text not null,
  reference   text,                              -- expected answer / key facts, if any
  verdict     text not null check (verdict in ('pass', 'partial', 'fail')),
  score       integer not null check (score between 0 and 100),
  -- {grounded, correct, guardrail_safe, tone} each 0-100 + freeform notes
  dimensions  jsonb not null default '{}'::jsonb,
  rationale   text not null default '',
  model_id    text,
  created_at  timestamptz not null default now()
);
create index if not exists eval_judgments_de_idx on eval_judgments(tenant_id, de_id, created_at desc);
create index if not exists eval_judgments_source_idx on eval_judgments(tenant_id, source, created_at desc);

alter table eval_judgments enable row level security;
drop policy if exists eval_judgments_read on eval_judgments;
create policy eval_judgments_read on eval_judgments for select using (
  tenant_id in (select p.tenant_id from profiles p where p.user_id = auth.uid())
  or exists (select 1 from profiles p where p.user_id = auth.uid() and p.layer = 'platform'));

-- Per-DE quality rollup over a window — feeds the Workbench, continuous-
-- eval drift alerts, and the trust auto-demote hook.
create or replace function public.de_eval_quality(p_tenant_id uuid, p_de_id uuid, p_days int default 7)
returns jsonb language sql stable security definer set search_path to 'public' as $function$
  select jsonb_build_object(
    'n', count(*),
    'avg_score', coalesce(round(avg(score)), 0),
    'pass_rate', coalesce(round(100.0 * count(*) filter (where verdict = 'pass') / nullif(count(*), 0)), 0),
    'fail_rate', coalesce(round(100.0 * count(*) filter (where verdict = 'fail') / nullif(count(*), 0)), 0),
    'by_source', coalesce((select jsonb_object_agg(source, c) from
       (select source, count(*) c from eval_judgments
        where tenant_id = p_tenant_id and de_id = p_de_id
          and created_at >= now() - make_interval(days => greatest(1, p_days)) group by source) s), '{}'::jsonb)
  )
  from eval_judgments
  where tenant_id = p_tenant_id and de_id = p_de_id
    and created_at >= now() - make_interval(days => greatest(1, p_days));
$function$;

revoke all on function public.de_eval_quality(uuid, uuid, int) from public, anon;
grant execute on function public.de_eval_quality(uuid, uuid, int) to authenticated, service_role;
