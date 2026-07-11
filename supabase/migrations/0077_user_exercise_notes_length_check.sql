-- 0077: length guard on user_exercise_notes.note.
--
-- The client caps note input at 1000 chars (TextInput maxLength); this makes
-- the same limit hold for direct API/integration writes. Separate from 0076
-- because 0076 is already applied to live. The client cap counts UTF-16
-- units and char_length counts codepoints, so client-capped text always
-- passes (units >= codepoints).
--
-- Apply to live via Supabase MCP apply_migration only (project rule: never
-- db push). Mirrored into schema.sql.

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'user_exercise_notes_note_length_check') then
    alter table public.user_exercise_notes add constraint user_exercise_notes_note_length_check
      check (char_length(note) <= 1000);
  end if;
end $$;
