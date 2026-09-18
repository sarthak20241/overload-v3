-- 0127_drona_card_later.sql — "Later" on a Drona card
--
-- Every card is now a popup (owner's decision, 2026-09-18). A popup needs a
-- third answer besides yes and no: Later. A deferred card leaves the dashboard
-- and waits on the From Drona screen, still pending, until the end of ITS week.
-- A card rests on last week's numbers; acting on it a fortnight later is worse
-- than losing it, so a deferred card expires on Sunday night in the user's zone.

alter table public.drona_cards
  add column if not exists deferred_at timestamptz;

-- The user may move status, decided_at and now deferred_at. Nothing else.
revoke update on public.drona_cards from authenticated;
grant update (status, decided_at, deferred_at) on public.drona_cards to authenticated;

-- Later, from the owner. Sets the expiry in the user's own zone: the card's
-- week ends at midnight before the next Monday, wherever the user is.
create or replace function public.drona_defer_card(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_status text;
  v_week date;
  v_tz text;
begin
  select user_id, status, week_start into v_owner, v_status, v_week
    from drona_cards where id = p_card_id for update;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_status <> 'pending' then return 'already_decided'; end if;

  v_tz := coalesce((select tz.name from user_profiles p
                      join pg_timezone_names tz on tz.name = p.timezone
                     where p.clerk_user_id = v_owner), 'UTC');

  update drona_cards
     set deferred_at = now(),
         expires_at = ((v_week + 7)::timestamp) at time zone v_tz
   where id = p_card_id;
  return 'ok';
end;
$function$;

revoke all on function public.drona_defer_card(uuid) from public, anon;
grant execute on function public.drona_defer_card(uuid) to authenticated;
