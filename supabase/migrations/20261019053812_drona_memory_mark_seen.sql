-- Drona memory catch: one way to mark a text as read.
--
-- Both the after-reply pass (ai-coach) and the daily sweep (drona-cards) call
-- this. A plain upsert cannot count tries (columns left out keep their old
-- value), and get_drona_memory_unseen gives a failed text 3 tries in all.
-- A text already read successfully is never downgraded by a later failure.

create or replace function public.drona_memory_mark_seen(
  p_user_id text, p_source_id text, p_outcome text, p_facts int, p_gate real, p_via text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $function$
  insert into coach_memory_seen as s (user_id, source_id, outcome, facts, gate, via)
  values (p_user_id, p_source_id, p_outcome, coalesce(p_facts, 0), p_gate, p_via)
  on conflict (user_id, source_id) do update set
    outcome = case when s.outcome <> 'failed' and excluded.outcome = 'failed' then s.outcome else excluded.outcome end,
    facts   = case when s.outcome <> 'failed' and excluded.outcome = 'failed' then s.facts else excluded.facts end,
    gate    = coalesce(excluded.gate, s.gate),
    via     = excluded.via,
    tries   = s.tries + 1,
    seen_at = now();
$function$;

revoke all on function public.drona_memory_mark_seen(text, text, text, int, real, text) from public, anon, authenticated;
grant execute on function public.drona_memory_mark_seen(text, text, text, int, real, text) to service_role;
