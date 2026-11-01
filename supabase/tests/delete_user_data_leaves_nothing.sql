-- Deleting an account leaves no row that names the person. A synthetic user
-- gets a row in every table delete_user_data() used to miss, then the function
-- runs and every table with a per-user column is swept for that id. The sweep
-- reads information_schema, so a new per-user table the function forgets fails
-- here too once the test seeds it. Synthetic users only; always rolled back.
begin;
insert into public.user_profiles (clerk_user_id) values ('del_leftover_a'), ('del_leftover_b');

do $$
declare
  a constant text := 'del_leftover_a';
  w uuid; wb uuid; m uuid; sm uuid; pc uuid;
  own_ex uuid; shared_ex uuid; routine_ex uuid; note_ex uuid; check_ex uuid; rb uuid;
  r record; n bigint; fks text; leftovers text[] := '{}';
begin
  -- delete_user_data keeps a custom exercise anything below still points at.
  -- A new FK to exercises would cascade or block silently: add it there first.
  select string_agg(conrelid::regclass::text, ',' order by conrelid::regclass::text) into fks
    from pg_constraint where contype = 'f' and confrelid = 'public.exercises'::regclass;
  if fks is distinct from 'form_checks,routine_exercises,user_exercise_notes,workout_exercise_notes,workout_sets' then
    raise exception 'FKs to exercises changed (%): update the exercise checks in delete_user_data', fks; end if;

  -- Training: A's own custom exercise in A's workout, and a second custom
  -- exercise of A's that B also trains with.
  insert into public.exercises(name, muscle_group, created_by) values ('Leftover test press', 'chest', a) returning id into own_ex;
  insert into public.exercises(name, muscle_group, created_by) values ('Leftover test hinge', 'back', a) returning id into shared_ex;
  insert into public.workouts(user_id, name) values (a, 'Leftover test day') returning id into w;
  insert into public.workout_sets(workout_id, exercise_id) values (w, own_ex), (w, shared_ex);
  insert into public.workouts(user_id, name) values ('del_leftover_b', 'Leftover test day B') returning id into wb;
  insert into public.workout_sets(workout_id, exercise_id) values (wb, shared_ex);
  insert into public.form_checks(user_id, exercise_id, exercise_name, summary) values (a, own_ex, 'Leftover test press', '{}');
  insert into public.form_check_rate_limit(user_id) values (a);
  -- Three more of A's custom exercises, each reaching B by one other path.
  insert into public.exercises(name, muscle_group, created_by) values ('Leftover test row', 'back', a) returning id into routine_ex;
  insert into public.exercises(name, muscle_group, created_by) values ('Leftover test curl', 'arms', a) returning id into note_ex;
  insert into public.exercises(name, muscle_group, created_by) values ('Leftover test squat', 'legs', a) returning id into check_ex;
  insert into public.routines(user_id, name) values ('del_leftover_b', 'Leftover test routine B') returning id into rb;
  insert into public.routine_exercises(routine_id, exercise_id) values (rb, routine_ex);
  insert into public.user_exercise_notes(user_id, exercise_id, note) values ('del_leftover_b', note_ex, 'leftover test');
  insert into public.form_checks(user_id, exercise_id, exercise_name, summary) values ('del_leftover_b', check_ex, 'Leftover test squat', '{}');

  -- Food: a logged meal (its entry writes user_food_cache), the typed text,
  -- a saved meal, a rejected alias, a personal precise alias, a private food.
  insert into public.meals(user_id, meal_type, logged_at) values (a, 'lunch', now() - interval '1 hour') returning id into m;
  insert into public.parse_traces(user_id, input_text, outcome, tier) values (a, '50g leftover test oats', 'meal', 'fast');
  insert into public.meal_entries(meal_id, food_name, quantity, serving_unit, grams_logged, kcal, protein_g, carb_g, fat_g, logged_via, source)
    values (m, 'Leftover test oats', 50, 'g', 50, 190, 6, 33, 3, 'ai', 'manual');
  insert into public.parse_meal_rate_limit(user_id) values (a);
  insert into public.saved_meals(user_id, name) values (a, 'Leftover test bowl') returning id into sm;
  insert into public.saved_meal_items(saved_meal_id, food_name) values (sm, 'Leftover test oats');
  insert into food_memory_private.alias_rejections(user_id, canonical_key, alias) values (a, 'leftover test oats', 'my oats');
  insert into public.precise_cache(cache_key, display_name, kcal, protein_g, carb_g, fat_g)
    values ('leftover-test-oats', 'Leftover test oats', 380, 12, 66, 6) returning id into pc;
  insert into public.precise_alias(alias_key, row_id, source, user_id) values ('my leftover oats', pc, 'jev', a);
  insert into public.foods(name, source, created_by) values ('Leftover test private food', 'user', a);

  -- Coach.
  insert into public.coach_memory_seen(user_id, source_id, outcome, via) values (a, 'leftover-test', 'nothing', 'sweep');
  insert into public.drona_word_signals(user_id, week_start, signal, fired) values (a, date '2026-10-26', 'hurting', true);
  insert into public.free_phase_builds(user_id, phase_id) values (a, gen_random_uuid());
  insert into public.coach_traces(user_id, status, http_status, last_user_message_preview) values (a, 'ok', 200, 'leftover test');

  -- Rows that stay, minus the person: the cost ledger and a used code.
  insert into public.token_usage_log(pipeline, provider, model, metadata) values
    ('leftover_test', 'anthropic', 'test', jsonb_build_object('user_id', a, 'mode', 'fast')),
    ('leftover_test', 'anthropic', 'test', jsonb_build_object('user', a));
  insert into public.redemption_codes(code, tier, source, redeemed_by_clerk_user_id, redeemed_at)
    values ('LEFTOVER-TEST-CODE', 'monthly', 'test', a, now());

  if not exists (select 1 from public.user_food_cache where user_id = a) then
    raise exception 'setup: the logged meal wrote no user_food_cache row'; end if;

  perform public.delete_user_data(a);

  -- Every base table with a per-user column, swept for A.
  for r in
    select c.table_schema, c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t using (table_schema, table_name)
     where t.table_type = 'BASE TABLE'
       and c.table_schema in ('public', 'private', 'food_memory_private')
       and c.column_name in ('user_id', 'clerk_user_id', 'created_by', 'redeemed_by_clerk_user_id')
     order by 1, 2
  loop
    execute format('select count(*) from %I.%I where %I::text = $1', r.table_schema, r.table_name, r.column_name)
      into n using a;
    if n > 0 then
      leftovers := leftovers || format('%s.%s.%s=%s', r.table_schema, r.table_name, r.column_name, n);
    end if;
  end loop;
  select count(*) into n from public.token_usage_log where metadata->>'user_id' = a or metadata->>'user' = a;
  if n > 0 then leftovers := leftovers || format('public.token_usage_log.metadata=%s', n); end if;

  if cardinality(leftovers) > 0 then
    raise exception 'delete_user_data left rows behind: %', array_to_string(leftovers, ', ');
  end if;

  -- What must survive.
  if not exists (select 1 from public.workout_sets where workout_id = wb and exercise_id = shared_ex) then
    raise exception 'deleting A took B''s set on A''s shared custom exercise'; end if;
  select string_agg(name, ', ' order by name) into fks from public.exercises
   where id in (shared_ex, routine_ex, note_ex, check_ex) and created_by is distinct from 'del_leftover_b';
  if fks is not null or (select count(*) from public.exercises where id in (shared_ex, routine_ex, note_ex, check_ex)) <> 4 then
    raise exception 'shared custom exercises not kept and passed to B: %', coalesce(fks, 'one was deleted'); end if;
  if not exists (select 1 from public.form_checks where user_id = 'del_leftover_b' and exercise_id = check_ex) then
    raise exception 'B''s form check lost its exercise'; end if;
  if exists (select 1 from public.exercises where id = own_ex) then
    raise exception 'A''s unshared custom exercise survived'; end if;
  if (select count(*) from public.token_usage_log where pipeline = 'leftover_test') <> 2 then
    raise exception 'the cost rows were deleted instead of cleaned'; end if;
  if not exists (select 1 from public.token_usage_log where pipeline = 'leftover_test' and metadata->>'mode' = 'fast') then
    raise exception 'cleaning the cost row dropped its other metadata'; end if;
  if not exists (select 1 from public.redemption_codes where code = 'LEFTOVER-TEST-CODE' and redeemed_at is not null) then
    raise exception 'the used code was deleted or reopened'; end if;
  if not exists (select 1 from public.precise_cache where id = pc) then
    raise exception 'the shared precise_cache row was deleted'; end if;
  if not exists (select 1 from public.user_profiles where clerk_user_id = 'del_leftover_b') then
    raise exception 'B''s profile went too'; end if;
end $$;

rollback;
