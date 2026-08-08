-- CENSUS, evidence source 2: CRON. A job that runs constantly and never
-- changes anything is pure burn. Rank by runs, and show failures — the infra
-- cost review found the real cost is elsewhere, but 42k runs/7d deserves a look.
select j.jobname,
       j.schedule,
       count(d.*)                                            as runs_7d,
       count(*) filter (where d.status <> 'succeeded')        as failures_7d,
       round(avg(extract(epoch from (d.end_time - d.start_time)))::numeric, 2) as avg_secs,
       max(d.start_time)                                     as last_run
  from cron.job j
  left join cron.job_run_details d
         on d.jobid = j.jobid and d.start_time > now() - interval '7 days'
 group by j.jobname, j.schedule
 order by runs_7d desc
 limit 20;
