-- 0092: Cardio bucket in the exercise catalog.
-- (Authored as "0090" and applied to prod 2026-07-30 as `cardio_exercises`,
--  but never committed. It collided with the weekly_reports pair, which also
--  claimed 0090/0091. Renumbered here to its actual apply position; the SQL
--  below is byte-identical to what ran.)
-- 1) rename imported dataset names to the app's names (ids untouched)
-- 2) move them to the Cardio group
-- 3) insert the picks the catalog was missing (global-row guard only)
-- 4) resync user_volume_stats / user_lift_stats for affected users

update exercises e set name = v.new_name
from (values
  ('Running, Treadmill', 'Treadmill Run'),
  ('Jogging, Treadmill', 'Treadmill Jog'),
  ('Walking, Treadmill', 'Treadmill Walk'),
  ('Elliptical Trainer', 'Elliptical'),
  ('Bicycling, Stationary', 'Stationary Bike'),
  ('Bicycling', 'Cycling'),
  ('Rowing, Stationary', 'Rowing Machine'),
  ('Stairmaster', 'Stair Climber')
) as v(old_name, new_name)
where e.created_by is null
  and lower(e.name) = lower(v.old_name)
  and not exists (
    select 1 from exercises x
    where x.created_by is null and lower(x.name) = lower(v.new_name)
  );

update exercises set muscle_group = 'Cardio'
where created_by is null
  and lower(name) in (
    'treadmill run', 'treadmill jog', 'treadmill walk', 'elliptical',
    'stationary bike', 'recumbent bike', 'cycling', 'rowing machine',
    'stair climber', 'trail running/walking'
  );

insert into exercises (name, muscle_group, category, metric_type)
select v.name, v.muscle_group, v.category, v.metric_type
from (values
  ('Incline Treadmill Walk','Cardio','Machine','distance_duration'),
  ('Ski Erg','Cardio','Machine','distance_duration'),
  ('Assault Bike','Cardio','Machine','resistance_duration'),
  ('Outdoor Run','Cardio','Bodyweight','distance_duration'),
  ('Outdoor Walk','Cardio','Bodyweight','distance_duration'),
  ('Swimming','Cardio','Other','distance_duration'),
  ('Jump Rope','Cardio','Other','duration'),
  ('Battle Ropes','Cardio','Other','duration'),
  ('Mountain Climber','Cardio','Bodyweight','duration'),
  ('Jumping Jacks','Cardio','Bodyweight','duration'),
  ('Burpee','Cardio','Bodyweight','bodyweight_reps')
) as v(name, muscle_group, category, metric_type)
where not exists (
  select 1 from exercises e
  where e.created_by is null and lower(e.name) = lower(v.name)
);

do $$
declare r record;
begin
  for r in
    select distinct w.user_id, date_trunc('week', w.started_at)::date as week_start
    from workout_sets s
      join workouts w on w.id = s.workout_id
      join exercises e on e.id = s.exercise_id
    where e.created_by is null and e.muscle_group = 'Cardio'
  loop
    perform recompute_user_volume_stat(r.user_id, 'Cardio', r.week_start);
    perform recompute_user_volume_stat(r.user_id, 'Quads', r.week_start);
  end loop;

  for r in
    select distinct w.user_id, s.exercise_id
    from workout_sets s
      join workouts w on w.id = s.workout_id
      join exercises e on e.id = s.exercise_id
    where e.created_by is null and e.muscle_group = 'Cardio'
  loop
    perform recompute_user_lift_stat(r.user_id, r.exercise_id);
  end loop;
end $$;
