-- Manual push (drona-push mode "send"): our own message to chosen accounts or
-- to everyone with a phone. push_sends gets kind 'manual', with the campaign id
-- as lapse_key, so the existing unique (user_id, kind, lapse_key) means one
-- copy per person per campaign however often the send is run.
--
-- get_push_targets: each chosen account that has a phone, with its local hour
-- (quiet hours) and tokens. A null list means everyone with a phone. An
-- account with no saved zone is read in UTC.

alter table public.push_sends drop constraint if exists push_sends_kind_check;
alter table public.push_sends add constraint push_sends_kind_check check (kind in ('food_lapse', 'manual'));

create or replace function public.get_push_targets(p_user_ids text[] default null, p_now timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', t.user_id,
           'hour', extract(hour from (p_now at time zone coalesce(z.name, 'UTC')))::int,
           'tokens', t.tokens
         ) order by t.user_id), '[]'::jsonb)
    from (
      select pt.user_id, jsonb_agg(pt.token order by pt.updated_at desc) as tokens
        from push_tokens pt
       where p_user_ids is null or pt.user_id = any (p_user_ids)
       group by pt.user_id
    ) t
    join user_profiles up on up.clerk_user_id = t.user_id
    left join pg_timezone_names z on z.name = up.timezone;
$$;

revoke all on function public.get_push_targets(text[], timestamptz) from public, anon, authenticated;
grant execute on function public.get_push_targets(text[], timestamptz) to service_role;

notify pgrst, 'reload schema';
