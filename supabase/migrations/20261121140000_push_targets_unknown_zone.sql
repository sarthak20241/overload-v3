-- get_push_targets: an account with no saved (or unknown) time zone gets hour
-- null instead of a UTC guess. The manual send (drona-push mode "send") skips
-- those people while quiet hours are on: a UTC 09:00-21:00 window can land at
-- 02:30 in India. Replaces the function from 20261121130000; nothing else moves.

create or replace function public.get_push_targets(p_user_ids text[] default null, p_now timestamptz default now())
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', t.user_id,
           'hour', case when z.name is null then null
                        else extract(hour from (p_now at time zone z.name))::int end,
           'tokens', t.tokens
         ) order by t.user_id), '[]'::jsonb)
    from (
      select pt.user_id, jsonb_agg(pt.token order by pt.updated_at desc) as tokens
        from push_tokens pt
       where p_user_ids is null or pt.user_id = any (p_user_ids)
       group by pt.user_id
    ) t
    left join user_profiles up on up.clerk_user_id = t.user_id
    left join pg_timezone_names z on z.name = up.timezone;
$$;

revoke all on function public.get_push_targets(text[], timestamptz) from public, anon, authenticated;
grant execute on function public.get_push_targets(text[], timestamptz) to service_role;

notify pgrst, 'reload schema';
