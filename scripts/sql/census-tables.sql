-- CENSUS, evidence source 1: TABLES never written since stats reset, and their
-- current row counts. A table with 0 rows AND 0 lifetime writes is dead weight
-- unless something is about to use it. n_live_tup is approximate but honest at
-- this scale.
select relname as table_name,
       n_live_tup as approx_rows,
       n_tup_ins as inserts,
       n_tup_upd as updates,
       n_tup_del as deletes,
       coalesce(seq_scan,0) + coalesce(idx_scan,0) as total_reads
  from pg_stat_user_tables
 where schemaname = 'public'
   and n_live_tup = 0
   and (n_tup_ins + n_tup_upd + n_tup_del) = 0
 order by total_reads asc, relname
 limit 60;
