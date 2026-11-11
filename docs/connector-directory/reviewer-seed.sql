-- Fills the directory REVIEWER account (never a real user) with 3 weeks of
-- data, so every test case has something to read.
-- Replace __UID__ with the reviewer's Clerk user id before running.
-- Every row id is md5('overload-review:' || key), so a re-run changes nothing
-- and the cleanup at the bottom removes exactly these rows.
-- Days are relative to the run date: the last seeded day is yesterday.

do $$
declare
  u text := '__UID__';
  d int; day date; wid uuid; mid uuid; i int;
  bench uuid := '920af9d9-094e-46fd-8646-6813e95b4b32';
  row_ uuid := 'e2ece4d3-f399-4cad-9129-41dedc1b6436';
  squat uuid := 'b5d374fc-ab22-4c5d-aea8-08832082141c';
  ohp uuid := '9fdc3471-53f4-493b-9dc8-2061f5ffbd8a';
  rdl uuid := 'be3aca16-bc1c-4d5e-85cf-165a56c6aec3';
  pulldown uuid := '8f7745f9-9617-495f-b710-d79b3a7ed1ff';
  curl uuid := 'db3cf759-e9c6-4922-be76-474d6752bdd8';
  incline uuid := '2710804d-4822-4322-87fe-ae550e5d0ae3';
  kind text; w numeric;
  -- breakfast, lunch, dinner, snack rotations: name, qty, unit, grams, kcal, p, c, f, fiber
  foods jsonb := '{
    "breakfast": [["Oats", 60, "g", 60, 233, 8, 40, 4, 6], ["Whole milk", 200, "ml", 206, 128, 7, 10, 7, 0], ["Banana", 1, "medium", 118, 105, 1, 27, 0, 3]],
    "breakfast2": [["Eggs, scrambled", 3, "large", 150, 225, 18, 2, 16, 0], ["Wholegrain toast", 2, "slice", 70, 170, 8, 28, 2, 4]],
    "lunch": [["Chicken breast, grilled", 180, "g", 180, 297, 56, 0, 6, 0], ["White rice, cooked", 200, "g", 200, 260, 5, 57, 1, 1], ["Mixed salad", 1, "bowl", 120, 30, 2, 5, 0, 2]],
    "lunch2": [["Turkey sandwich", 1, "sandwich", 220, 420, 30, 45, 12, 5], ["Apple", 1, "medium", 182, 95, 0, 25, 0, 4]],
    "dinner": [["Salmon fillet, baked", 170, "g", 170, 350, 37, 0, 22, 0], ["Sweet potato, baked", 200, "g", 200, 180, 4, 41, 0, 7], ["Broccoli, steamed", 150, "g", 150, 52, 4, 10, 1, 5]],
    "dinner2": [["Lean beef mince, 5% fat", 150, "g", 150, 255, 32, 0, 13, 0], ["Pasta, cooked", 220, "g", 220, 348, 13, 68, 2, 4], ["Tomato sauce", 120, "g", 120, 60, 2, 10, 1, 2]],
    "snack": [["Greek yogurt, 0% fat", 200, "g", 200, 118, 20, 7, 1, 0], ["Whey protein shake", 1, "scoop", 30, 120, 24, 3, 2, 0]]
  }';
  meal text; pick text; f jsonb; pos int;
begin
  if not exists (select 1 from user_profiles where clerk_user_id = u) then
    raise exception 'no profile for %; open the app with the reviewer account once', u;
  end if;

  update user_profiles set
    name = 'Alex Reviewer', tier = 'annual', tier_started_at = now(),
    tier_expires_at = '2027-12-31', purchase_provider = null,
    height_cm = 180, weight_kg = 78.2, goal_weight_kg = 75, gender = coalesce(gender, 'M'), experience_level = coalesce(experience_level, 'intermediate'),
    goal = 'fat_loss', daily_calorie_target = 2200, protein_target_g = 165,
    carb_target_g = 230, fat_target_g = 70, timezone = 'America/New_York'
  where clerk_user_id = u;

  for d in 1..21 loop
    day := current_date - d;

    -- Body weight: 79.0 kg three weeks ago down to about 78.0 yesterday.
    insert into daily_metrics (user_id, metric_date, metric_type, value, unit, source)
    select u, day, 'bodyweight_kg', round(78.0 + (d - 1) * 0.05 + ((d * 7) % 5 - 2) * 0.1, 1), 'kg', 'manual'
    where not exists (select 1 from daily_metrics
                       where user_id = u and metric_date = day and metric_type = 'bodyweight_kg');

    -- Four meals a day.
    foreach meal in array array['breakfast', 'lunch', 'dinner', 'snack'] loop
      pick := case when meal <> 'snack' and d % 2 = 0 then meal || '2' else meal end;
      mid := md5('overload-review:meal:' || day || ':' || meal)::uuid;
      insert into meals (id, user_id, logged_at, meal_type)
      values (mid, u, (day + case meal when 'breakfast' then time '08:00' when 'lunch' then time '13:00'
                                     when 'dinner' then time '19:30' else time '16:00' end) at time zone 'America/New_York', meal)
      on conflict (id) do nothing;
      pos := 0;
      for f in select * from jsonb_array_elements(foods->pick) loop
        insert into meal_entries (id, meal_id, food_name, quantity, serving_unit, grams_logged,
          kcal, protein_g, carb_g, fat_g, fiber_g, position, source, origin, logged_via)
        values (md5('overload-review:entry:' || day || ':' || meal || ':' || pos)::uuid, mid,
          f->>0, (f->>1)::numeric, f->>2, (f->>3)::numeric, (f->>4)::numeric, (f->>5)::numeric,
          (f->>6)::numeric, (f->>7)::numeric, (f->>8)::numeric, pos, 'manual', 'user_typed', 'manual')
        on conflict (id) do nothing;
        pos := pos + 1;
      end loop;
    end loop;

    -- Workouts Mon / Wed / Fri: push, pull, legs. Bench goes up 2.5 kg a week.
    if extract(isodow from day) in (1, 3, 5) then
      kind := case extract(isodow from day) when 1 then 'Push' when 3 then 'Pull' else 'Legs' end;
      wid := md5('overload-review:workout:' || day)::uuid;
      w := 2.5 * (3 - (d - 1) / 7); -- +0 / +2.5 / +5 kg, newest week heaviest
      insert into workouts (id, user_id, name, started_at, finished_at, duration_seconds)
      values (wid, u, kind, (day + time '18:00') at time zone 'America/New_York',
              (day + time '19:05') at time zone 'America/New_York', 3900)
      on conflict (id) do nothing;
      if not exists (select 1 from workout_sets where workout_id = wid) then
        for i in 0..2 loop
          if kind = 'Push' then
            insert into workout_sets (workout_id, exercise_id, weight_kg, reps, completed, "order")
            values (wid, bench, 75 + w, 8, true, i), (wid, ohp, 45 + w / 2, 8, true, 3 + i),
                   (wid, incline, 26, 10, true, 6 + i);
          elsif kind = 'Pull' then
            insert into workout_sets (workout_id, exercise_id, weight_kg, reps, completed, "order")
            values (wid, row_, 65 + w, 8, true, i), (wid, pulldown, 60, 10, true, 3 + i),
                   (wid, curl, 30, 10, true, 6 + i);
          else
            insert into workout_sets (workout_id, exercise_id, weight_kg, reps, completed, "order")
            values (wid, squat, 95 + w, 6, true, i), (wid, rdl, 80 + w, 8, true, 3 + i);
          end if;
        end loop;
        update workouts set total_volume_kg =
          (select sum(weight_kg * reps) from workout_sets where workout_id = wid) where id = wid;
      end if;
    end if;
  end loop;
end $$;

-- Cleanup (removes only the seeded rows):
-- delete from workouts where user_id = '__UID__' and id in (select md5('overload-review:workout:' || (current_date - g))::uuid from generate_series(0, 60) g);
-- delete from meals where user_id = '__UID__' and id in (select md5('overload-review:meal:' || (current_date - g) || ':' || m)::uuid from generate_series(0, 60) g, unnest(array['breakfast','lunch','dinner','snack']) m);
-- delete from daily_metrics where user_id = '__UID__' and source = 'manual';
