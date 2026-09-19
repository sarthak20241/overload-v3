-- 0128_drona_card_undone.sql — an undone card says so
--
-- Undo closed the card as 'dismissed', the same word as "no thanks". On the
-- From Drona screen a swap the user applied and then put back read "You kept
-- the plan", which is not what happened. A card whose change was reverted is
-- now 'undone'; a card where there was nothing left to put back stays dismissed.
alter table public.drona_cards drop constraint if exists drona_cards_status_check;
alter table public.drona_cards add constraint drona_cards_status_check
  check (status in ('pending', 'applied', 'dismissed', 'undone', 'opened', 'done', 'expired', 'held'));

create or replace function public.drona_undo_swap(p_card_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_owner text;
  v_topic text;
  v_result text;
begin
  select user_id, topic into v_owner, v_topic from drona_cards where id = p_card_id;
  if v_owner is null then return 'no_card'; end if;
  if v_owner is distinct from current_clerk_user_id() then return 'forbidden'; end if;
  if v_topic <> 'swap' then return 'not_a_swap'; end if;

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
