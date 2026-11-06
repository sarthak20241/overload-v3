-- Food box thread usage, last 7 days: per user, then one 'ALL' row.
-- Read-only. Reads the steps food_bar_traces keeps per message (ai-coach):
--   food_threads_index  the index line's size (chars, names, cards listed / total)
--   food_threads        a thread read that hit the 800 ms timeout
--   copy_lines          one per call: source_kind thread | diary, and its
--                       copied / already_on_card / not_found counts
--   restore_card        restored, not_found, no_thread, or card_open (refused)
--   read_card           found or not
with s as (
  select t.user_id, t.request_id, st->>'tool' as tool, st->'result' as r
  from public.food_bar_traces t
  cross join lateral jsonb_array_elements(coalesce(t.steps, '[]'::jsonb)) st
  where t.created_at > now() - interval '7 days'
    and st->>'tool' in ('food_threads_index', 'food_threads', 'copy_lines', 'restore_card', 'read_card')
)
select
  coalesce(user_id, 'ALL') as user_id,
  count(distinct request_id) filter (where tool = 'food_threads_index') as msgs_with_index,
  round(avg((r->>'chars')::int) filter (where tool = 'food_threads_index')) as index_chars_avg,
  max((r->>'chars')::int) filter (where tool = 'food_threads_index') as index_chars_max,
  round(avg((r->>'names')::int) filter (where tool = 'food_threads_index'), 1) as index_names_avg,
  max((r->>'names')::int) filter (where tool = 'food_threads_index') as index_names_max,
  count(*) filter (where tool = 'food_threads' and r->>'reason' = 'read_timeout_800ms') as read_timeouts,
  count(*) filter (where tool = 'copy_lines' and r->>'source_kind' = 'thread') as copy_calls_thread,
  count(*) filter (where tool = 'copy_lines' and r->>'source_kind' = 'diary') as copy_calls_diary,
  coalesce(sum((r->>'copied')::int) filter (where tool = 'copy_lines'), 0) as lines_copied,
  coalesce(sum((r->>'already_on_card')::int) filter (where tool = 'copy_lines'), 0) as lines_already_on_card,
  coalesce(sum((r->>'not_found')::int) filter (where tool = 'copy_lines'), 0) as lines_not_found,
  count(*) filter (where tool = 'copy_lines' and r->>'error' is not null) as copy_errors,
  count(*) filter (where tool = 'restore_card' and r->>'reason' = 'restored') as restores,
  count(*) filter (where tool = 'restore_card' and r->>'reason' = 'card_open') as restores_refused_card_open,
  count(*) filter (where tool = 'restore_card' and r->>'reason' in ('not_found', 'no_thread')) as restores_failed,
  count(*) filter (where tool = 'read_card') as read_card_calls
from s
group by grouping sets ((user_id), ())
order by (user_id is null), msgs_with_index desc, user_id;
