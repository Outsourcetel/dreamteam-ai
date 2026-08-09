select h.type,
       h.title,
       count(*)                                as repeats,
       min(h.created_at)::date                 as first_seen,
       max(h.created_at)::date                 as last_seen,
       (now()::date - min(h.created_at)::date) as age_days,
       coalesce(de.name, '(unattributed)')     as employee,
       h.assigned_role,
       h.related_table,
       left(coalesce(min(h.detail), ''), 500)  as detail,
       (array_agg(h.id::text order by h.created_at))[1] as sample_id
  from human_tasks h
  left join digital_employees de on de.id = h.de_id
  join tenants t on t.id = h.tenant_id
 where h.status = 'pending'
   and t.plan = 'enterprise' and t.status = 'active'
 group by h.type, h.title, de.name, h.assigned_role, h.related_table
 order by count(*) desc, min(h.created_at);
