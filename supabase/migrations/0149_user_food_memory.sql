-- 0149: remember which logging tier produced each logged food, so a user's own
-- recent foods can answer their next log consistently (userFoodMemory.ts).
--
-- WHY. The same person logging "grilled chicken breast" twice could get two
-- different numbers: a new wording was a new web lookup, and a close tie between
-- lab rows was a coin flip for Jev. Owner decision 2026-09-27: a food the user
-- logged in the last 10 days answers first, for that user only, and the tier it
-- came from decides where it may be reused:
--   precise  -> every tier (our most accurate tier)
--   thorough -> thorough and fast
--   fast     -> fast only (a Quick guess the user accepted)
-- Numbers the user typed or picked themselves (source/logged_via 'manual') are
-- theirs and serve every tier; the edge function decides that, not this file.
--
-- WHAT.
--   1. meal_entries.tier: the tier whose numbers this line carries. Null for
--      old rows and for lines we cannot attribute (treated as fast: safe side).
--   2. parse_traces.tier: the tier each parse ran in, written by ai-coach.
--   3. A BEFORE INSERT trigger that stamps meal_entries.tier from the parse the
--      line came from: same user, a trace in the last 6 hours whose items hold a
--      line with the same food_name and the same rounded kcal. The client writes
--      the parser's final numbers unchanged (lib/dietData.ts logSection), so an
--      unedited line matches exactly; an edited one does not, and stays null.
--      An item may carry its own `numbers_tier` (a line answered from the user's
--      memory keeps the tier of the entry it came from); that wins over the
--      trace's tier. No app update is needed for any of this.
--
-- Additive. Reversible: drop the trigger, the function and the two columns.

begin;

alter table public.meal_entries add column if not exists tier text
  check (tier in ('fast', 'thorough', 'precise'));

alter table public.parse_traces add column if not exists tier text
  check (tier in ('fast', 'thorough', 'precise'));

create or replace function public.meal_entries_stamp_tier()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user text;
  v_tier text;
begin
  if new.tier is not null or new.logged_via is distinct from 'ai' or new.food_name is null or new.kcal is null then
    return new;
  end if;
  select m.user_id into v_user from public.meals m where m.id = new.meal_id;
  if v_user is null then
    return new;
  end if;
  select coalesce(i->>'numbers_tier', t.tier) into v_tier
  from public.parse_traces t
  cross join lateral jsonb_array_elements(coalesce(t.items, '[]'::jsonb)) i
  where t.user_id = v_user
    and t.created_at > now() - interval '6 hours'
    and t.tier is not null
    and lower(i->>'food_name') = lower(new.food_name)
    and (i->>'kcal') ~ '^-?[0-9]+(\.[0-9]+)?$'
    and round((i->>'kcal')::numeric) = round(new.kcal)
  order by t.created_at desc
  limit 1;
  if v_tier in ('fast', 'thorough', 'precise') then
    new.tier := v_tier;
  end if;
  return new;
exception when others then
  -- Never cost the user their log over a label.
  return new;
end;
$$;
revoke all on function public.meal_entries_stamp_tier() from public, anon, authenticated;

drop trigger if exists trg_meal_entries_stamp_tier on public.meal_entries;
create trigger trg_meal_entries_stamp_tier
  before insert on public.meal_entries
  for each row execute function public.meal_entries_stamp_tier();

-- 4. One-time backfill for the memory window (10 days, plus a day of slack), so
-- existing logs are useful from the first parse instead of all counting as
-- Quick. Old traces carry no tier column, so it is read off their steps:
-- any Precise step means precise, Quick's estimate call means fast, and the
-- plain extract call means thorough. A line is matched to the trace closest in
-- time to its meal row with the same user, food_name and rounded kcal.
with traces as (
  select t.user_id, t.created_at, t.items,
         case
           when exists (select 1 from jsonb_array_elements(t.steps) s
                        where s->>'tool' in ('super_lookup', 'precise_cache_hit', 'our_sources', 'tavily_search')) then 'precise'
           when exists (select 1 from jsonb_array_elements(t.steps) s where s->>'tool' = 'estimate_meal') then 'fast'
           when exists (select 1 from jsonb_array_elements(t.steps) s where s->>'tool' = 'extract_meal') then 'thorough'
         end as tier
  from public.parse_traces t
  where t.created_at > now() - interval '12 days' and t.outcome = 'meal'
),
picked as (
  select distinct on (e.id) e.id, tr.tier
  from public.meal_entries e
  join public.meals m on m.id = e.meal_id
  join traces tr on tr.user_id = m.user_id and tr.tier is not null
  cross join lateral jsonb_array_elements(coalesce(tr.items, '[]'::jsonb)) i
  where e.tier is null
    and e.logged_via in ('ai', 'ai_auto')
    and m.logged_at > now() - interval '11 days'
    and lower(i->>'food_name') = lower(e.food_name)
    and (i->>'kcal') ~ '^-?[0-9]+(\.[0-9]+)?$'
    and round((i->>'kcal')::numeric) = round(e.kcal)
  order by e.id, abs(extract(epoch from (tr.created_at - m.created_at)))
)
update public.meal_entries e set tier = p.tier from picked p where p.id = e.id;

commit;

-- Verify after applying:
--   select column_name from information_schema.columns
--    where table_name in ('meal_entries','parse_traces') and column_name = 'tier';   -- 2 rows
--   select tgname from pg_trigger where tgname = 'trg_meal_entries_stamp_tier';     -- 1 row
--   select tier, count(*) from meal_entries e join meals m on m.id = e.meal_id
--    where m.logged_at > now() - interval '11 days' group by 1;                    -- backfill spread
