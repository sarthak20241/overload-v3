-- Drona memory catch: at the 60-fact cap, safety facts are evicted last
-- (PR #268 review). With automatic saving, a person can reach the cap with
-- small facts; the oldest-first eviction could then drop an allergy or an
-- injury. injury, diet and constraint now go only after every other category.

create or replace function public.coach_remember_fact_for(
  p_user_id text, p_category text, p_key text, p_value text, p_source text default 'sweep'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  uid      text := p_user_id;
  v_key    text := lower(regexp_replace(btrim(coalesce(p_key, '')), '\s+', ' ', 'g'));
  v_value  text := regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g');
  v_source text := case when p_source in ('chat', 'food_log', 'sweep') then p_source else 'sweep' end;
  v_cap    constant int := 60;
  v_id     uuid;
  v_new    boolean;
  v_active int;
begin
  if uid is null or not exists (select 1 from public.user_profiles where clerk_user_id = uid) then
    return jsonb_build_object('saved', false, 'reason', 'unknown user');
  end if;
  if p_category is null or p_category not in (
       'preference', 'constraint', 'injury', 'equipment', 'schedule',
       'diet', 'goal_context', 'decision', 'other') then
    return jsonb_build_object('saved', false, 'reason', 'bad category');
  end if;
  if length(v_key) < 1 or length(v_key) > 60 then
    return jsonb_build_object('saved', false, 'reason', 'key must be 1 to 60 characters');
  end if;
  if length(v_value) < 1 or length(v_value) > 300 then
    return jsonb_build_object('saved', false, 'reason', 'value must be 1 to 300 characters');
  end if;

  -- Only an active row is updated; a dismissed one matches the conflict but the
  -- WHERE leaves it alone, so nothing comes back and the save is refused.
  insert into public.coach_memory as m (user_id, category, key, value, source)
  values (uid, p_category, v_key, v_value, v_source)
  on conflict (user_id, category, key) do update
     set value = excluded.value, source = excluded.source, updated_at = now()
   where m.status = 'active'
  returning m.id, (xmax = 0) into v_id, v_new;

  if v_id is null then
    return jsonb_build_object('saved', false, 'reason', 'the person asked to forget this');
  end if;

  if v_new then
    select count(*) into v_active from public.coach_memory where user_id = uid and status = 'active';
    if v_active > v_cap then
      delete from public.coach_memory
       where id in (select id from public.coach_memory
                     where user_id = uid and status = 'active' and id <> v_id
                     -- Safety facts go last: an old allergy or injury must not
                     -- make room for a newer, smaller fact.
                     order by (category in ('injury', 'diet', 'constraint')), updated_at asc
                     limit v_active - v_cap);
    end if;
  end if;

  return jsonb_build_object('saved', true, 'updated', not v_new, 'id', v_id);
end;
$function$;

revoke all on function public.coach_remember_fact_for(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.coach_remember_fact_for(text, text, text, text, text) to service_role;
