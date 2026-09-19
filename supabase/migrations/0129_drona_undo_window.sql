-- 0129_drona_undo_window.sql — the server holds the Undo rule, not the phone
--
-- lib/dronaInbox decides whether Undo is shown: a swap that landed can be put
-- back for seven days, from decided_at when the user applied it, from
-- created_at when Drona applied it itself. drona_undo_swap did not check any of
-- that, so a call past the window, or on a card already answered, still moved
-- the routine. Raised in review of PR #186.
create or replace function public.drona_undo_swap(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_topic text;
  v_status text;
  v_since timestamptz;
  v_result text;
begin
  select user_id, topic, status,
         case status when 'applied' then decided_at else created_at end
    into v_owner, v_topic, v_status, v_since
    from drona_cards where id = p_card_id;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_topic <> 'swap' then return 'not_a_swap'; end if;
  if v_status not in ('pending', 'applied') then return 'already_decided'; end if;
  if v_since is null or v_since < now() - interval '7 days' then return 'too_late'; end if;

  v_result := private.drona_swap_move(p_card_id, true);
  -- Close the card either way: the user has answered. 'undone' only when the
  -- exercise really went back; 'dismissed' when their own edit had moved on.
  update drona_cards
     set status = case when v_result = 'ok' then 'undone' else 'dismissed' end,
         decided_at = now()
   where id = p_card_id and status in ('pending', 'applied');
  return v_result;
end;
$function$;

revoke all on function public.drona_undo_swap(uuid) from public, anon;
grant execute on function public.drona_undo_swap(uuid) to authenticated;
