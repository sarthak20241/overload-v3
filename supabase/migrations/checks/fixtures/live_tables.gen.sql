-- Builds fixtures/live_tables.sql from the live project (read only). See that file.
with t as (
  select c.oid, n.nspname, c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','food_memory_private') and c.relkind in ('r','p')
),
cols as (
  select t.oid, string_agg(format('  %I %s%s%s', a.attname,
      case when format_type(a.atttypid,a.atttypmod) like 'vector%' then 'text' else format_type(a.atttypid,a.atttypmod) end,
      case when a.attgenerated='s' then ' generated always as ('||pg_get_expr(d.adbin,d.adrelid)||') stored' else '' end,
      case when a.attnotnull then ' not null' else '' end), E',\n' order by a.attnum) body
  from t join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  group by t.oid
),
tables as (
  select string_agg(format(E'create table %I.%I (\n%s\n);', t.nspname, t.relname, cols.body), E'\n' order by t.nspname, t.relname) s
  from t join cols using (oid)
),
cons as (
  select string_agg(format('alter table %I.%I add constraint %I %s;', t.nspname, t.relname, co.conname, pg_get_constraintdef(co.oid, true)), E'\n'
    order by co.contype desc, t.nspname, t.relname, co.conname) s
  from t join pg_constraint co on co.conrelid=t.oid and co.contype in ('p','u')
),
fks as (
  select string_agg(format('alter table %I.%I add constraint %I %s;', t.nspname, t.relname, co.conname, pg_get_constraintdef(co.oid, true)), E'\n'
    order by t.nspname, t.relname, co.conname) s
  from t join pg_constraint co on co.conrelid=t.oid and co.contype = 'f'
),
idx as (
  select string_agg(pg_get_indexdef(i.indexrelid)||';', E'\n' order by t.relname) s
  from t join pg_index i on i.indrelid=t.oid and i.indisunique
  where not exists (select 1 from pg_constraint co where co.conindid=i.indexrelid)
)
select tables.s || E'\n\n' || cons.s || E'\n\n' || coalesce(idx.s,'') || E'\n\n' || fks.s as ddl from tables, cons, idx, fks;
