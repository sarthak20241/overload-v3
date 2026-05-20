-- 0025_pending_distillation_edit.sql
--
-- Phase 3 curator polish: let admin reviewers fix Haiku's distillation
-- inline when it gets a detail wrong, rather than rejecting an otherwise-
-- good paper.
--
-- Whitelist of editable fields (population, intervention, key_finding,
-- practical_takeaway). Embedding is NOT regenerated — corrected wording
-- doesn't materially shift retrieval, and the alternative (Voyage call
-- from a server action) would leak the API key into the admin app's env.
-- If a substantive rewrite happens we can add a "Re-embed" button later
-- that calls the ingest worker out-of-band.
--
-- topic_tags and other structural fields are NOT in the whitelist —
-- those would actually shift retrieval and need re-embedding to stay
-- coherent.

create or replace function update_pending_distillation(
  p_pending_id uuid,
  p_field      text,
  p_value      text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'update_pending_distillation: caller is not an admin';
  end if;

  -- Explicit whitelist so a bug in the client can't write to embedding,
  -- trust_score, or any column we haven't blessed.
  case p_field
    when 'key_finding'        then update research_kb_pending set key_finding        = p_value where id = p_pending_id;
    when 'practical_takeaway' then update research_kb_pending set practical_takeaway = p_value where id = p_pending_id;
    when 'population'         then update research_kb_pending set population         = p_value where id = p_pending_id;
    when 'intervention'       then update research_kb_pending set intervention       = p_value where id = p_pending_id;
    else
      raise exception 'update_pending_distillation: field % is not editable', p_field;
  end case;
end;
$$;
grant execute on function update_pending_distillation(uuid, text, text) to authenticated;
