-- Live table shapes for delete_user_data.check.ts, read on 2026-11-21 from the
-- live project by live_tables.gen.sql (schemas public and food_memory_private):
-- columns, primary keys, unique keys and indexes, foreign keys with their
-- ON DELETE rule, and the triggers that fire on a user_profiles delete (at the
-- end). Left out on purpose: defaults, check constraints, other triggers,
-- RLS. The check fills every column itself, so it needs none of them.
-- vector columns are text here (PGlite has no pgvector loaded).
-- Regenerate when tables change:
--   cd <main checkout> && supabase db query --linked -o json -f supabase/migrations/checks/fixtures/live_tables.gen.sql
-- then write rows[0].ddl under this header.
create schema if not exists food_memory_private;
create or replace function public.immutable_unaccent(text) returns text
  language sql immutable as $$ select $1 $$;

create table food_memory_private.alias_rejections (
  user_id text not null,
  canonical_key text not null,
  alias text not null,
  entry_id uuid,
  rejected_at timestamp with time zone not null
);
create table food_memory_private.user_food_cache_backup_20261107 (
  id uuid,
  user_id text,
  canonical_key text,
  food_name text,
  food_id uuid,
  kcal numeric,
  protein_g numeric,
  carb_g numeric,
  fat_g numeric,
  fiber_g numeric,
  serving_label text,
  serving_grams numeric,
  source text,
  tier text,
  aliases text[],
  alias_evidence jsonb,
  last_entry_id uuid,
  last_logged_at timestamp with time zone,
  confirmed_at timestamp with time zone,
  brand text
);
create table food_memory_private.user_food_versions (
  id uuid not null,
  cache_id uuid not null,
  user_id text not null,
  canonical_key text not null,
  food_name text not null,
  kcal numeric not null,
  protein_g numeric not null,
  carb_g numeric not null,
  fat_g numeric not null,
  fiber_g numeric,
  serving_label text,
  serving_grams numeric,
  origin text not null,
  copied_from text,
  recipe jsonb,
  tier text,
  entry_id uuid,
  state text not null,
  valid_from timestamp with time zone not null,
  valid_to timestamp with time zone
);
create table public._fndds_label_backup_20260717 (
  id uuid,
  food_id uuid,
  label text,
  grams numeric,
  is_default boolean,
  seq integer
);
create table public.admin_users (
  clerk_user_id text not null,
  email text,
  added_at timestamp with time zone not null,
  added_by text,
  notes text
);
create table public.agent_review_log (
  id uuid not null,
  pending_id uuid not null,
  paper_url text not null,
  paper_title text not null,
  proposed_action text not null,
  final_action text not null,
  downgrade_reason text,
  rationale text not null,
  confidence numeric(3,2) not null,
  flags text[] not null,
  superseded_kb_ids uuid[] not null,
  new_kb_id uuid,
  agent_model text not null,
  decided_at timestamp with time zone not null,
  raw_response jsonb,
  reverted_at timestamp with time zone,
  reverted_by text,
  revert_reason text
);
create table public.ai_coach_rate_limit (
  user_id text not null,
  request_at timestamp with time zone not null
);
create table public.anon_plan_usage (
  id bigint not null,
  device_id text not null,
  ip text,
  created_at timestamp with time zone not null
);
create table public.body_measurements (
  user_id text not null,
  measured_on date not null,
  site text not null,
  value_cm numeric(6,2) not null,
  source text not null,
  updated_at timestamp with time zone not null
);
create table public.bug_reports (
  id uuid not null,
  user_id text,
  category text not null,
  title text not null,
  description text,
  created_at timestamp with time zone not null
);
create table public.coach_memory (
  id uuid not null,
  user_id text not null,
  category text not null,
  key text not null,
  value text not null,
  source text not null,
  status text not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);
create table public.coach_memory_seen (
  user_id text not null,
  source_id text not null,
  outcome text not null,
  facts integer not null,
  tries integer not null,
  gate real,
  via text not null,
  seen_at timestamp with time zone not null
);
create table public.coach_program_phase_metric_logs (
  id uuid not null,
  metric_id uuid not null,
  user_id text not null,
  value numeric not null,
  logged_on date not null,
  note text,
  created_at timestamp with time zone not null
);
create table public.coach_program_phase_metrics (
  id uuid not null,
  program_id uuid not null,
  phase_id uuid not null,
  user_id text not null,
  seq integer not null,
  is_hero boolean not null,
  kind text not null,
  ref jsonb,
  unit text,
  direction text not null,
  start_value numeric,
  target_value numeric,
  current_value numeric,
  status text not null,
  status_note text,
  checked_at timestamp with time zone,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  checked_week date,
  retry_tries integer not null,
  retry_week date
);
create table public.coach_program_phases (
  id uuid not null,
  program_id uuid not null,
  user_id text not null,
  seq integer not null,
  name text not null,
  duration_weeks integer not null,
  start_offset_weeks integer not null,
  diet_calorie_target integer,
  diet_protein_g integer,
  diet_carb_g integer,
  diet_fat_g integer,
  diet_directive text,
  training_directive text,
  readiness_directive text,
  training_block jsonb,
  routine_id uuid,
  created_at timestamp with time zone not null,
  diet_fuel_days jsonb,
  activity_steps_target integer,
  cardio_sessions_per_week integer,
  job_text text,
  coach_line text
);
create table public.coach_programs (
  id uuid not null,
  user_id text not null,
  title text not null,
  objective text,
  goal text,
  target_weight_kg numeric,
  target_date date,
  start_date date not null,
  status text not null,
  applied_phase_seq integer,
  total_weeks integer,
  source text not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  maintenance_basis_kcal integer
);
create table public.coach_traces (
  id uuid not null,
  user_id text,
  request_at timestamp with time zone not null,
  latency_ms integer,
  status text not null,
  http_status integer not null,
  error_message text,
  model text,
  input_tokens integer,
  output_tokens integer,
  cache_creation_input_tokens integer,
  cache_read_input_tokens integer,
  message_count integer,
  has_user_context boolean,
  retrieved_doc_ids text[] not null,
  citation_ids text[] not null,
  last_user_message_preview text,
  response_preview text,
  tool_calls text[] not null,
  retrieval_status text,
  mode text,
  spans jsonb,
  retrieval_query_rewritten boolean,
  retrieval_query text,
  retrieval_rewrite_error text,
  request_id uuid
);
create table public.coach_trials (
  clerk_user_id text not null,
  started_at timestamp with time zone not null,
  expires_at timestamp with time zone not null,
  messages_sent integer not null,
  message_cap integer not null,
  ended_at timestamp with time zone,
  end_reason text
);
create table public.coupon_batches (
  id text not null,
  period text not null,
  offer_id text not null,
  kind text not null,
  count integer not null,
  expires date,
  status text not null,
  sandbox boolean not null,
  error text,
  created_by text,
  created_at timestamp with time zone not null
);
create table public.coupons (
  code text not null,
  batch_id text not null,
  period text not null,
  kind text not null,
  expires date,
  sandbox boolean not null,
  given_at timestamp with time zone,
  given_to text,
  given_by text,
  note text,
  created_at timestamp with time zone not null
);
create table public.daily_metrics (
  user_id text not null,
  metric_date date not null,
  metric_type text not null,
  value numeric not null,
  unit text,
  source text not null,
  updated_at timestamp with time zone not null
);
create table public.daily_suggestions (
  user_id text not null,
  day date not null,
  kind text not null,
  routine_id uuid,
  resumes_on date,
  scheduled boolean not null,
  basis text not null,
  source text not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);
create table public.drona_behaviours (
  user_id text not null,
  week_start date not null,
  behaviour text not null,
  priority integer not null,
  card_kind text not null,
  meta boolean not null,
  mutes text[] not null,
  detail jsonb not null,
  rule_version integer not null,
  computed_at timestamp with time zone not null
);
create table public.drona_cards (
  id uuid not null,
  user_id text not null,
  week_start date not null,
  kind text not null,
  topic text not null,
  title text not null,
  body text not null,
  evidence jsonb not null,
  payload jsonb not null,
  signals text[] not null,
  facts jsonb not null,
  rejected jsonb,
  summary text,
  status text not null,
  source text not null,
  created_at timestamp with time zone not null,
  decided_at timestamp with time zone,
  expires_at timestamp with time zone,
  deferred_at timestamp with time zone,
  slot text not null,
  moment_day date
);
create table public.drona_change_outcome_facts (
  change_id bigint not null,
  user_id text not null,
  changed_at timestamp with time zone not null,
  changed_on date not null,
  entity text,
  action text,
  source text,
  label text,
  card_id uuid,
  same_day_changes integer not null,
  other_changes_before integer not null,
  other_changes_after integer not null,
  after_days integer not null,
  b_sessions integer,
  a_sessions integer,
  b_training_days integer,
  a_training_days integer,
  b_working_sets integer,
  a_working_sets integer,
  b_pick_match numeric,
  a_pick_match numeric,
  b_food_days integer,
  a_food_days integer,
  b_avg_kcal numeric,
  a_avg_kcal numeric,
  b_avg_target_kcal numeric,
  a_avg_target_kcal numeric,
  b_avg_protein_g numeric,
  a_avg_protein_g numeric,
  b_weigh_ins integer,
  a_weigh_ins integer,
  b_avg_kg numeric,
  a_avg_kg numeric,
  computed_at timestamp with time zone not null
);
create table public.drona_day_facts (
  user_id text not null,
  day date not null,
  kcal numeric(8,1),
  protein_g numeric(7,1),
  carb_g numeric(7,1),
  fat_g numeric(7,1),
  fiber_g numeric(7,1),
  fiber_entries integer,
  entries integer,
  meals integer,
  has_breakfast boolean,
  has_lunch boolean,
  has_dinner boolean,
  has_snack boolean,
  entries_ai integer,
  entries_catalog integer,
  entries_estimate integer,
  entries_typed integer,
  entries_unknown_src integer,
  logged_same_day boolean,
  target_kcal integer,
  target_protein_g integer,
  target_carb_g integer,
  target_fat_g integer,
  target_source text,
  computed_at timestamp with time zone not null
);
create table public.drona_exercise_habit_week_facts (
  user_id text not null,
  week_start date not null,
  exercise_id uuid not null,
  exercise_name text,
  custom boolean not null,
  in_phase boolean not null,
  phase_routines integer not null,
  sessions integer not null,
  working_sets integer not null,
  routine_sessions_planned integer not null,
  routine_sessions_done integer not null,
  routine_sessions_skipped integer not null,
  sessions_added integer not null,
  sessions_freestyle integer not null,
  computed_at timestamp with time zone not null
);
create table public.drona_exercise_week_facts (
  user_id text not null,
  week_start date not null,
  exercise_id uuid not null,
  exercise_name text,
  muscle text,
  parent text,
  metric_type text,
  sessions integer,
  working_sets integer,
  reps integer,
  volume_kg numeric(10,1),
  top_weight_kg numeric(7,2),
  reps_at_top integer,
  best_e1rm_kg numeric(7,1),
  best_reps integer,
  longest_hold_s integer,
  in_program boolean,
  in_any_routine boolean,
  computed_at timestamp with time zone not null
);
create table public.drona_facts_runs (
  user_id text not null,
  last_day_done date,
  last_started_at timestamp with time zone,
  last_ms integer,
  last_errors jsonb,
  runs integer not null
);
create table public.drona_moment_asks (
  user_id text not null,
  source_id text not null,
  day date not null,
  change text not null,
  status text not null,
  created_at timestamp with time zone not null
);
create table public.drona_muscle_week_facts (
  user_id text not null,
  week_start date not null,
  muscle text not null,
  parent text not null,
  role text not null,
  sessions integer,
  working_sets integer,
  reps integer,
  volume_kg numeric(10,1),
  exercises integer,
  computed_at timestamp with time zone not null
);
create table public.drona_pick_muscle_day_facts (
  user_id text not null,
  day date not null,
  muscle text not null,
  parent text not null,
  role text not null,
  planned_sets integer not null,
  done_sets integer not null,
  computed_at timestamp with time zone not null
);
create table public.drona_plan_muscle_week_facts (
  user_id text not null,
  week_start date not null,
  muscle text not null,
  parent text not null,
  role text not null,
  plan_days integer not null,
  planned_sets numeric(6,1) not null,
  done_sets integer not null,
  computed_at timestamp with time zone not null
);
create table public.drona_recovery_day_facts (
  user_id text not null,
  day date not null,
  readiness integer,
  sleep_min integer,
  sleep_ok boolean,
  sleep_source text,
  sleep_quality integer,
  steps integer,
  steps_zero boolean,
  steps_partial boolean,
  steps_source text,
  rhr_bpm numeric(5,1),
  hrv_ms numeric(6,1),
  active_kcal numeric(7,1),
  dropped text[],
  computed_at timestamp with time zone not null,
  sleep_matches_prefill boolean,
  readiness_parts_saved boolean,
  readiness_formula integer,
  readiness_tier text,
  readiness_provisional boolean,
  readiness_sleep_basis text,
  readiness_base_score integer,
  readiness_sleep_points numeric(6,2),
  readiness_rhr_why text,
  readiness_rhr_points numeric(6,2),
  readiness_hrv_why text,
  readiness_hrv_points numeric(6,2),
  readiness_load_points integer,
  readiness_diet_points integer
);
create table public.drona_signals (
  user_id text not null,
  week_start date not null,
  signal text not null,
  fired boolean not null,
  pattern boolean not null,
  detail jsonb not null,
  rule_version integer not null,
  computed_at timestamp with time zone not null
);
create table public.drona_training_day_facts (
  user_id text not null,
  day date not null,
  sessions integer,
  minutes integer,
  odd_sessions integer,
  working_sets integer,
  reps integer,
  volume_kg numeric(10,1),
  sessions_phase integer,
  sessions_other_routine integer,
  sessions_freestyle integer,
  rpe_sets integer,
  warmup_sets integer,
  muscles text[],
  parents text[],
  pick_kind text,
  pick_routine_id uuid,
  pick_followed boolean,
  early_sessions integer,
  late_days integer,
  overdue boolean,
  computed_at timestamp with time zone not null,
  pick_exercise_overlap numeric(4,2),
  pick_parent_overlap numeric(4,2),
  pick_sets_planned integer,
  pick_sets_matched integer,
  pick_set_match numeric(4,2),
  pick_muscle_set_match numeric(4,2),
  pick_parents_missed text[],
  pick_parents_extra text[],
  pick_sets_extra integer,
  best_routine_id uuid,
  best_routine_similarity numeric(4,2)
);
create table public.drona_week_facts (
  user_id text not null,
  week_start date not null,
  w_readings integer,
  w_dropped_impossible integer,
  w_avg_kg numeric(6,2),
  w_min_kg numeric(6,2),
  w_max_kg numeric(6,2),
  w_first_kg numeric(6,2),
  w_first_on date,
  w_last_kg numeric(6,2),
  w_last_on date,
  w_delta_prev_week_kg numeric(6,2),
  w_typical_swing_kg numeric(6,2),
  w_sources text[],
  bf_readings integer,
  bf_avg_percent numeric(5,2),
  tape_days integer,
  tape_sites text[],
  computed_at timestamp with time zone not null,
  source_version integer not null,
  f_days_elapsed integer,
  f_days_logged integer,
  f_entries integer,
  f_avg_kcal numeric(7,1),
  f_avg_protein_g numeric(6,1),
  f_avg_carb_g numeric(6,1),
  f_avg_fat_g numeric(6,1),
  f_target_kcal integer,
  f_target_protein_g integer,
  f_target_source text,
  f_target_changed_in_week boolean,
  f_days_within_10pct integer,
  f_days_over_10pct integer,
  f_days_under_10pct integer,
  f_highest_kcal integer,
  f_highest_on date,
  f_lowest_kcal integer,
  f_lowest_on date,
  f_single_entry_days integer,
  f_computed_at timestamp with time zone,
  f_days_missed integer,
  f_longest_missed_run integer,
  f_streak_at_end integer,
  f_weekday_days_logged integer,
  f_weekend_days_logged integer,
  f_days_breakfast integer,
  f_days_lunch integer,
  f_days_dinner integer,
  f_days_snack integer,
  f_days_under_half_target integer,
  f_days_logged_same_day integer,
  f_median_kcal numeric(7,1),
  f_weekday_avg_kcal numeric(7,1),
  f_weekend_avg_kcal numeric(7,1),
  f_kcal_stddev numeric(7,1),
  f_total_kcal integer,
  f_total_target_kcal integer,
  f_target_carb_g integer,
  f_target_fat_g integer,
  f_days_protein_met integer,
  f_days_carb_met integer,
  f_days_fat_met integer,
  f_days_protein_under_half integer,
  f_days_carb_under_half integer,
  f_days_fat_under_half integer,
  f_days_any_macro_under_half integer,
  f_avg_fiber_g numeric(6,1),
  f_fiber_days integer,
  f_entries_ai integer,
  f_entries_catalog integer,
  f_entries_estimate integer,
  f_entries_typed integer,
  f_entries_unknown_src integer,
  t_days_elapsed integer,
  t_sessions integer,
  t_training_days integer,
  t_minutes integer,
  t_avg_session_minutes integer,
  t_odd_sessions integer,
  t_working_sets integer,
  t_reps integer,
  t_volume_kg numeric(12,1),
  t_rpe_sets integer,
  t_warmup_sets integer,
  t_longest_train_run integer,
  t_longest_rest_run integer,
  t_days_since_last_session integer,
  t_back_to_back_days integer,
  t_back_to_back_muscles text[],
  t_planned_sessions integer,
  t_plan_source text,
  t_sessions_phase integer,
  t_sessions_other_routine integer,
  t_sessions_freestyle integer,
  t_early_sessions integer,
  t_overdue_days integer,
  t_picks_offered integer,
  t_picks_followed integer,
  t_routine_sessions integer,
  t_routine_exercises_planned integer,
  t_routine_exercises_done integer,
  t_routine_exercises_added integer,
  t_routine_sets_planned integer,
  t_routine_sets_done integer,
  t_exercises integer,
  t_exercises_off_program integer,
  t_parents_trained text[],
  t_computed_at timestamp with time zone,
  t_picks_trained_other integer,
  t_pick_parent_overlap_avg numeric(4,2),
  t_pick_days_trained integer,
  t_pick_sets_planned integer,
  t_pick_sets_matched integer,
  t_pick_set_match numeric(4,2),
  t_plan_days integer,
  t_plan_sets_planned numeric(6,1),
  t_plan_sets_matched numeric(6,1),
  t_plan_set_match numeric(4,2),
  t_plan_sets_extra integer,
  t_plan_parents_missed text[],
  r_readiness_days integer,
  r_readiness_avg numeric(5,1),
  r_readiness_min integer,
  r_readiness_max integer,
  r_readiness_low_days integer,
  r_sleep_nights integer,
  r_sleep_avg_min integer,
  r_sleep_min_min integer,
  r_sleep_max_min integer,
  r_sleep_stddev_min integer,
  r_sleep_implausible integer,
  r_sleep_sources text[],
  r_sleep_quality_days integer,
  r_sleep_quality_avg numeric(3,1),
  r_steps_days integer,
  r_steps_avg integer,
  r_steps_min integer,
  r_steps_max integer,
  r_steps_zero_days integer,
  r_steps_partial_days integer,
  r_steps_sources text[],
  r_rhr_days integer,
  r_rhr_avg numeric(5,1),
  r_hrv_days integer,
  r_hrv_avg numeric(6,1),
  r_active_kcal_days integer,
  r_active_kcal_avg integer,
  r_dropped_implausible integer,
  r_sleep_avg_delta_prev_week integer,
  r_steps_avg_delta_prev_week integer,
  r_readiness_avg_delta_prev_week numeric(5,1),
  r_computed_at timestamp with time zone,
  r_sleep_prefill_nights integer,
  r_parts_days integer,
  r_no_score_days integer,
  r_a1_days integer,
  r_a2_days integer,
  r_a3_days integer,
  r_provisional_days integer,
  r_rhr_unused_days integer,
  r_hrv_unused_days integer,
  r_sleep_points_avg numeric(5,1),
  r_rhr_points_avg numeric(5,1),
  r_hrv_points_avg numeric(5,1),
  r_load_points_sum integer,
  r_diet_points_avg numeric(5,1),
  p_as_of date,
  p_diary_days integer,
  p_changes integer,
  p_changes_by_source jsonb,
  p_changes_by_entity jsonb,
  p_target_changes integer,
  p_goal_changes integer,
  p_program_changes integer,
  p_phase_changes integer,
  p_routine_changes integer,
  p_card_changes integer,
  p_change_list jsonb,
  p_days_since_target_change integer,
  p_days_since_plan_change integer,
  p_kcal_target integer,
  p_kcal_target_delta integer,
  p_protein_target_g integer,
  p_target_src text,
  p_goal text,
  p_goal_weight_kg numeric(5,1),
  p_weekly_target_sessions integer,
  p_goal_src text,
  p_program_id uuid,
  p_program_title text,
  p_program_goal text,
  p_program_src text,
  p_program_start date,
  p_program_total_weeks integer,
  p_program_week integer,
  p_program_weeks_left integer,
  p_program_target_date date,
  p_program_target_kg numeric(5,1),
  p_phase_id uuid,
  p_phase_seq integer,
  p_phase_name text,
  p_phase_week integer,
  p_phase_weeks integer,
  p_phase_weeks_left integer,
  p_phase_built boolean,
  p_phase_kcal integer,
  p_phase_protein_g integer,
  p_programs_created integer,
  p_programs_ended integer,
  p_computed_at timestamp with time zone,
  wd_workout_notes integer,
  wd_exercise_notes integer,
  wd_sticky_notes integer,
  wd_meal_notes integer,
  wd_chat_messages integer,
  wd_chat_unanswered integer,
  wd_chat_repeats integer,
  wd_chat_by_mode jsonb,
  wd_memory_facts integer,
  wd_days_with_words integer,
  wd_chars integer,
  wd_texts jsonb,
  wd_injury_notes text,
  wd_training_prefs text,
  wd_computed_at timestamp with time zone,
  c_card_id uuid,
  c_kind text,
  c_topic text,
  c_title text,
  c_signals text[],
  c_action text,
  c_status text,
  c_outcome text,
  c_seen_possible boolean,
  c_deferred boolean,
  c_hours_to_later numeric(7,1),
  c_hours_to_answer numeric(7,1),
  c_plan_changes integer,
  c_followed_through boolean,
  c_hours_to_follow numeric(7,1),
  c_cards_to_date integer,
  c_answered_to_date integer,
  c_later_to_date integer,
  c_ignored_to_date integer,
  c_holds_to_date integer,
  c_computed_at timestamp with time zone,
  c_done_before_card boolean,
  g_window_from date,
  g_window_to date,
  g_readings integer,
  g_rate_kg_per_week numeric,
  g_now_kg numeric,
  g_now_on date,
  g_goal_kg numeric,
  g_goal_from text,
  g_target_date date,
  g_target_from text,
  g_kg_to_go numeric,
  g_weeks_left numeric,
  g_needed_kg_per_week numeric,
  g_eta_weeks numeric,
  g_eta_date date,
  e_food_days integer,
  e_food_days_under_half integer,
  e_avg_kcal numeric,
  e_avg_kcal_full numeric,
  e_maint_kcal integer,
  e_maint_kcal_full integer,
  t_weekdays integer[],
  t_weekday_weeks_8w jsonb,
  t_weeks_trained_8w integer,
  c_by_topic_to_date jsonb,
  s_computed_at timestamp with time zone,
  g_span_days integer,
  m_window_to date,
  m_trend_kg numeric,
  m_trend_rate_kg_per_week numeric,
  m_readings_28 integer,
  m_outliers_28 integer,
  m_span_days integer,
  m_last_weigh_in date,
  m_whole_days_28 integer,
  m_intake_kcal numeric,
  m_observed_kcal integer,
  m_data_weight numeric,
  m_bmr_kcal integer,
  m_guess_kcal integer,
  m_prev_kcal integer,
  m_step_kcal integer,
  m_estimate_kcal integer,
  m_data_weeks numeric,
  m_source text,
  m_computed_at timestamp with time zone,
  a_as_of date,
  a_steps_target integer,
  a_steps_days integer,
  a_steps_days_met integer,
  a_cardio_target integer,
  a_cardio_sessions integer,
  a_computed_at timestamp with time zone
);
create table public.drona_word_facts (
  user_id text not null,
  kind text not null,
  source_id text not null,
  day date not null,
  context text,
  text text not null,
  chars integer not null,
  is_preview boolean not null,
  answered boolean,
  is_repeat boolean not null,
  computed_at timestamp with time zone not null
);
create table public.drona_word_signals (
  user_id text not null,
  week_start date not null,
  signal text not null,
  fired boolean not null,
  detail jsonb not null,
  model text,
  computed_at timestamp with time zone not null
);
create table public.exercises (
  id uuid not null,
  name text not null,
  muscle_group text not null,
  category text not null,
  created_at timestamp with time zone not null,
  created_by text,
  metric_type text not null,
  instructions text[] not null,
  image_urls text[] not null,
  movement_pattern text,
  form_rules jsonb,
  name_lower text generated always as (lower(name)) stored,
  target_muscle text,
  swap_pattern text
);
create table public.food_bar_traces (
  id uuid not null,
  request_id uuid not null,
  user_id text not null,
  created_at timestamp with time zone not null,
  status text not null,
  error text,
  input_text text not null,
  meal_hint text,
  speed text,
  tier_used text,
  streamed boolean,
  client_id text,
  auto_log boolean,
  can_create boolean,
  request jsonb,
  card_lines integer,
  card_may_be_cut boolean,
  card_open boolean,
  recent_turns_sent integer,
  router_intent text,
  router_confidence real,
  router_source text,
  router jsonb,
  planned_action text,
  served_action text,
  fallback text,
  answered_by text,
  served_kind text,
  served_text text,
  served jsonb,
  steps jsonb,
  steps_dropped integer,
  model_calls jsonb,
  calls_dropped integer,
  anthropic_calls integer,
  jev_calls integer,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer
);
create table public.food_card_lines (
  card_id uuid not null,
  version integer not null,
  line_id text not null,
  line_no integer not null,
  name text not null,
  said_name text,
  grams numeric,
  quantity numeric,
  unit text,
  kcal numeric not null,
  protein_g numeric,
  carb_g numeric,
  fat_g numeric,
  fiber_g numeric,
  source text,
  source_ref text,
  confidence text,
  note text,
  meal_type text,
  recipe jsonb
);
create table public.food_cards (
  id uuid not null,
  thread_id uuid not null,
  kind text not null,
  version integer not null,
  status text not null,
  meal_type text,
  day date,
  last_client_id text,
  max_line_no integer not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);
create table public.food_log_stats (
  food_id uuid not null,
  logs integer not null
);
create table public.food_servings (
  id uuid not null,
  food_id uuid not null,
  label text not null,
  grams numeric not null,
  is_default boolean not null,
  source text not null,
  seq integer not null
);
create table public.food_thread_turns (
  thread_id uuid not null,
  seq integer not null,
  role text not null,
  text text not null,
  client_id text,
  created_at timestamp with time zone not null
);
create table public.food_threads (
  id uuid not null,
  user_id text not null,
  started_at timestamp with time zone not null,
  last_at timestamp with time zone not null,
  status text not null,
  closed_why text,
  summary text
);
create table public.foods (
  id uuid not null,
  name text not null,
  food_category text not null,
  kcal numeric not null,
  protein_g numeric not null,
  carb_g numeric not null,
  fat_g numeric not null,
  brand text,
  barcode text,
  image_url text,
  source text not null,
  created_by text,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  base_unit text not null,
  density_g_per_ml numeric,
  fiber_g numeric,
  sugar_g numeric,
  sat_fat_g numeric,
  sodium_mg numeric,
  micros jsonb,
  sources text[],
  region text,
  search_text text generated always as (immutable_unaccent(lower(name))) stored,
  embedding text,
  rank_boost real not null,
  last_verified_at timestamp with time zone
);
create table public.form_check_rate_limit (
  user_id text not null,
  request_at timestamp with time zone not null
);
create table public.form_checks (
  id uuid not null,
  user_id text not null,
  exercise_id uuid,
  exercise_name text not null,
  movement_pattern text,
  source text not null,
  summary jsonb not null,
  note text,
  score integer,
  created_at timestamp with time zone not null
);
create table public.founding_tier_claims (
  tier text not null,
  cap integer not null,
  claimed integer not null,
  closed_at timestamp with time zone
);
create table public.free_goal_builds (
  user_id text not null,
  build_attempts integer not null,
  edit_turns integer not null,
  build_source text,
  first_at timestamp with time zone not null,
  last_at timestamp with time zone not null
);
create table public.free_phase_builds (
  user_id text not null,
  phase_id uuid not null,
  attempts integer not null,
  first_at timestamp with time zone not null,
  last_at timestamp with time zone not null,
  refine_turns integer not null
);
create table public.health_cardio_imports (
  user_id text not null,
  source text not null,
  external_id text not null,
  workout_id uuid,
  imported_at timestamp with time zone not null
);
create table public.ingest_checkpoints (
  source text not null,
  last_fetched_at timestamp with time zone not null,
  last_pub_date date,
  last_identifier text,
  papers_fetched integer not null,
  papers_added integer not null,
  last_run_at timestamp with time zone,
  last_error text
);
create table public.invite_codes (
  code text not null,
  owner_email text,
  owner_clerk_user_id text,
  source text not null,
  max_redemptions integer,
  max_rewards integer,
  created_at timestamp with time zone not null,
  sent_at timestamp with time zone,
  days integer not null,
  expires_at timestamp with time zone,
  note text,
  given_to text,
  made_by text
);
create table public.invite_events (
  id bigint not null,
  code text not null,
  kind text not null,
  at timestamp with time zone not null
);
create table public.invite_failed_tries (
  id bigint not null,
  clerk_user_id text not null,
  at timestamp with time zone not null
);
create table public.invite_redemptions (
  clerk_user_id text not null,
  code text not null,
  is_owner boolean not null,
  days_granted integer not null,
  redeemed_at timestamp with time zone not null,
  owner_rewarded boolean not null
);
create table public.kv_store_89faff51 (
  key text not null,
  value jsonb not null
);
create table public.marketing_waitlist (
  id uuid not null,
  email text not null,
  source text,
  referrer text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  user_agent text,
  ip_country text,
  created_at timestamp with time zone not null
);
create table public.mcp_requests (
  user_id text not null,
  request_id text not null,
  tool text not null,
  result jsonb,
  created_at timestamp with time zone not null
);
create table public.mcp_traces (
  id bigint not null,
  user_id text not null,
  tool text not null,
  status text not null,
  ms integer not null,
  client_id text,
  created_at timestamp with time zone not null,
  user_agent text
);
create table public.meal_entries (
  id uuid not null,
  meal_id uuid not null,
  food_id uuid,
  food_name text not null,
  quantity numeric not null,
  serving_unit text not null,
  kcal numeric not null,
  protein_g numeric not null,
  carb_g numeric not null,
  fat_g numeric not null,
  "position" integer not null,
  serving_id uuid,
  grams_logged numeric,
  fiber_g numeric,
  sugar_g numeric,
  sat_fat_g numeric,
  sodium_mg numeric,
  logged_via text,
  source text,
  client_id uuid,
  tier text,
  origin text,
  copied_from text,
  recipe jsonb,
  created_at timestamp with time zone
);
create table public.meals (
  id uuid not null,
  user_id text not null,
  logged_at timestamp with time zone not null,
  meal_type text not null,
  note text,
  client_id uuid,
  created_at timestamp with time zone not null
);
create table public.model_pricing (
  model text not null,
  provider text not null,
  input_per_million_usd numeric(10,6) not null,
  output_per_million_usd numeric(10,6) not null,
  cache_read_per_million_usd numeric(10,6),
  cache_creation_per_million_usd numeric(10,6),
  updated_at timestamp with time zone not null
);
create table public.parse_meal_rate_limit (
  user_id text not null,
  request_at timestamp with time zone not null
);
create table public.parse_traces (
  id uuid not null,
  user_id text,
  created_at timestamp with time zone not null,
  input_text text not null,
  meal_hint text,
  model text,
  outcome text not null,
  message text,
  iterations integer,
  steps jsonb,
  items jsonb,
  input_tokens integer,
  output_tokens integer,
  web_search_requests integer,
  latency_ms integer,
  tier text,
  request_id uuid,
  served_action text,
  served_text text
);
create table public.plan_changes (
  id bigint not null,
  user_id text not null,
  occurred_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  entity text not null,
  entity_id text,
  action text not null,
  changes jsonb not null,
  source text not null,
  card_id uuid,
  label text
);
create table public.precise_alias (
  alias_key text not null,
  row_id uuid not null,
  source text not null,
  confidence numeric,
  created_at timestamp with time zone not null,
  user_id text,
  id uuid not null
);
create table public.precise_cache (
  id uuid not null,
  cache_key text not null,
  display_name text not null,
  brand text,
  base_unit text not null,
  kcal numeric not null,
  protein_g numeric not null,
  carb_g numeric not null,
  fat_g numeric not null,
  fiber_g numeric,
  servings jsonb not null,
  evidence jsonb not null,
  sources text[] not null,
  verified boolean not null,
  source_note text,
  promoted_food_id uuid,
  promoted_at timestamp with time zone,
  created_at timestamp with time zone not null,
  last_verified_at timestamp with time zone not null,
  embedding text
);
create table public.publisher_denylist (
  pattern text not null,
  reason text,
  added_at timestamp with time zone not null
);
create table public.push_sends (
  id bigint not null,
  user_id text not null,
  kind text not null,
  lapse_key text not null,
  title text not null,
  body text not null,
  tickets jsonb not null,
  status text not null,
  sent_at timestamp with time zone not null,
  receipt_checked_at timestamp with time zone
);
create table public.push_tokens (
  token text not null,
  user_id text not null,
  platform text not null,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);
create table public.readiness_parts (
  user_id text not null,
  metric_date date not null,
  formula integer not null,
  score integer,
  tier text not null,
  band text,
  provisional boolean not null,
  sleep_basis text,
  sleep_points numeric(6,2),
  rhr_why text,
  rhr_points numeric(6,2),
  hrv_why text,
  hrv_points numeric(6,2),
  base_score integer,
  load_points integer,
  diet_points integer,
  parts jsonb not null,
  updated_at timestamp with time zone not null
);
create table public.redemption_codes (
  code text not null,
  tier text not null,
  source text not null,
  created_at timestamp with time zone not null,
  created_by text,
  redeemed_by_clerk_user_id text,
  redeemed_at timestamp with time zone,
  expires_at timestamp with time zone,
  notes text
);
create table public.research_kb (
  id uuid not null,
  source text not null,
  url text not null,
  title text not null,
  authors text[] not null,
  journal text,
  pub_year integer,
  pub_date date,
  topic_tags text[] not null,
  study_design text,
  confidence text,
  population text,
  intervention text,
  key_finding text not null,
  practical_takeaway text not null,
  trust_score numeric(3,2) not null,
  license text,
  ingested_at timestamp with time zone not null,
  updated_at timestamp with time zone not null,
  embedding text,
  superseded_by uuid,
  superseded_at timestamp with time zone,
  superseded_by_reviewer text
);
create table public.research_kb_pending (
  id uuid not null,
  source text not null,
  url text not null,
  title text not null,
  authors text[] not null,
  journal text,
  pub_year integer,
  pub_date date,
  topic_tags text[] not null,
  study_design text,
  confidence text,
  population text,
  intervention text,
  key_finding text not null,
  practical_takeaway text not null,
  trust_score numeric(3,2) not null,
  license text,
  embedding text,
  ingested_at timestamp with time zone not null,
  review_status text not null,
  reviewed_at timestamp with time zone,
  reviewed_by text,
  rejection_reason text,
  source_meta jsonb,
  contradiction_flags jsonb,
  agent_recommendation jsonb
);
create table public.routine_exercises (
  id uuid not null,
  routine_id uuid not null,
  exercise_id uuid not null,
  sets integer not null,
  reps_min integer not null,
  reps_max integer not null,
  rest_seconds integer not null,
  "order" integer not null,
  note text,
  superset_group integer,
  target_duration_seconds integer,
  target_distance_m numeric
);
create table public.routine_snapshots (
  routine_id uuid not null,
  user_id text not null,
  exercises jsonb not null,
  updated_at timestamp with time zone not null
);
create table public.routines (
  id uuid not null,
  user_id text not null,
  name text not null,
  description text,
  color text not null,
  created_at timestamp with time zone not null,
  program_phase_id uuid,
  source text
);
create table public.saved_meal_items (
  id uuid not null,
  saved_meal_id uuid not null,
  food_id uuid,
  food_name text not null,
  quantity numeric not null,
  serving_unit text not null,
  grams_logged numeric,
  kcal numeric not null,
  protein_g numeric,
  carb_g numeric,
  fat_g numeric,
  fiber_g numeric,
  sugar_g numeric,
  sat_fat_g numeric,
  sodium_mg numeric,
  "position" integer not null,
  origin text
);
create table public.saved_meals (
  id uuid not null,
  user_id text not null,
  name text not null,
  kind text not null,
  servings numeric not null,
  serving_label text,
  kcal numeric not null,
  protein_g numeric not null,
  carb_g numeric not null,
  fat_g numeric not null,
  note text,
  created_at timestamp with time zone not null
);
create table public.server_tool_pricing (
  provider text not null,
  tool text not null,
  metadata_key text not null,
  unit_usd numeric(12,6) not null,
  unit text not null,
  updated_at timestamp with time zone not null
);
create table public.timezone_names (
  name text not null
);
create table public.token_usage_log (
  id uuid not null,
  recorded_at timestamp with time zone not null,
  pipeline text not null,
  provider text not null,
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  cache_read_input_tokens integer not null,
  cache_creation_input_tokens integer not null,
  cost_usd numeric(10,6) not null,
  metadata jsonb,
  latency_ms integer,
  status text not null,
  error_message text
);
create table public.user_day_targets (
  user_id text not null,
  day date not null,
  kcal numeric not null,
  protein_g numeric,
  carb_g numeric,
  fat_g numeric,
  created_at timestamp with time zone not null
);
create table public.user_exercise_notes (
  user_id text not null,
  exercise_id uuid not null,
  note text not null,
  updated_at timestamp with time zone not null
);
create table public.user_food_cache (
  id uuid not null,
  user_id text not null,
  canonical_key text not null,
  food_name text not null,
  food_id uuid,
  kcal numeric not null,
  protein_g numeric not null,
  carb_g numeric not null,
  fat_g numeric not null,
  fiber_g numeric,
  serving_label text,
  serving_grams numeric,
  source text,
  tier text not null,
  aliases text[] not null,
  alias_evidence jsonb not null,
  last_entry_id uuid not null,
  last_logged_at timestamp with time zone not null,
  confirmed_at timestamp with time zone not null,
  brand text,
  origin text,
  copied_from text,
  recipe jsonb,
  valid_from timestamp with time zone
);
create table public.user_lift_stats (
  user_id text not null,
  exercise_id uuid not null,
  exercise_name text not null,
  muscle_group text not null,
  estimated_1rm numeric(10,2),
  top_set_weight numeric(10,2),
  top_set_reps numeric,
  last_performed_at timestamp with time zone,
  sessions_last_28d integer not null,
  updated_at timestamp with time zone not null,
  last_set_weight numeric(10,2),
  last_set_reps numeric
);
create table public.user_nutrition_stats (
  user_id text not null,
  day date not null,
  kcal numeric(12,2) not null,
  protein_g numeric(12,2) not null,
  carb_g numeric(12,2) not null,
  fat_g numeric(12,2) not null,
  entry_count integer not null,
  updated_at timestamp with time zone not null
);
create table public.user_profiles (
  id uuid not null,
  clerk_user_id text not null,
  name text not null,
  email text not null,
  avatar_url text,
  gender text,
  height_cm numeric,
  weight_kg numeric,
  goal_weight_kg numeric,
  body_fat_percent numeric,
  level integer not null,
  xp integer not null,
  streak integer not null,
  created_at timestamp with time zone not null,
  goal text,
  experience_level text,
  training_age_months integer,
  date_of_birth date,
  weekly_target_sessions integer,
  tier text not null,
  tier_started_at timestamp with time zone,
  tier_expires_at timestamp with time zone,
  purchase_provider text,
  purchase_id text,
  daily_calorie_target numeric,
  protein_target_g numeric,
  carb_target_g numeric,
  fat_target_g numeric,
  goal_detail text,
  goal_target_date date,
  diet_preference text,
  injury_notes text,
  medication_notes text,
  wearable_connection_status text,
  training_preferences text,
  timezone text,
  goal_focus_areas text[],
  drona_auto_adjust boolean not null,
  calorie_day_boosts jsonb,
  goals text[],
  connect_plan text,
  connect_started_at timestamp with time zone,
  connect_expires_at timestamp with time zone
);
create table public.user_target_history (
  user_id text not null,
  effective_from date not null,
  kcal numeric,
  protein_g numeric,
  carb_g numeric,
  fat_g numeric,
  calorie_day_boosts jsonb,
  recorded_at timestamp with time zone not null
);
create table public.user_volume_stats (
  user_id text not null,
  muscle_group text not null,
  week_start date not null,
  total_volume_kg numeric(12,2) not null,
  set_count integer not null,
  updated_at timestamp with time zone not null
);
create table public.weekly_reports (
  id uuid not null,
  user_id text not null,
  week_start date not null,
  facts jsonb not null,
  narrative jsonb,
  status text not null,
  model text,
  error text,
  regen_count smallint not null,
  seen_at timestamp with time zone,
  created_at timestamp with time zone not null,
  updated_at timestamp with time zone not null
);
create table public.workout_exercise_notes (
  workout_id uuid not null,
  exercise_id uuid not null,
  note text not null,
  created_at timestamp with time zone not null
);
create table public.workout_sets (
  id uuid not null,
  workout_id uuid not null,
  exercise_id uuid not null,
  weight_kg numeric not null,
  reps numeric not null,
  completed boolean not null,
  "order" integer not null,
  duration_seconds integer,
  distance_m numeric,
  resistance numeric,
  set_type text not null,
  rpe numeric(3,1),
  is_unilateral boolean not null,
  reps_right numeric,
  rpe_right numeric,
  weight_kg_right numeric,
  superset_group integer
);
create table public.workouts (
  id uuid not null,
  user_id text not null,
  routine_id uuid,
  name text not null,
  started_at timestamp with time zone not null,
  finished_at timestamp with time zone,
  duration_seconds integer,
  total_volume_kg numeric,
  notes text,
  created_at timestamp with time zone not null,
  client_id uuid,
  source text
);

alter table public.coach_memory add constraint coach_memory_user_id_category_key_key UNIQUE (user_id, category, key);
alter table public.coach_program_phase_metric_logs add constraint coach_program_phase_metric_logs_metric_id_logged_on_key UNIQUE (metric_id, logged_on);
alter table public.coach_program_phase_metrics add constraint coach_program_phase_metrics_phase_id_seq_key UNIQUE (phase_id, seq);
alter table public.coach_program_phases add constraint coach_program_phases_program_id_seq_key UNIQUE (program_id, seq);
alter table public.food_bar_traces add constraint food_bar_traces_request_id_key UNIQUE (request_id);
alter table public.precise_alias add constraint precise_alias_owner_key UNIQUE NULLS NOT DISTINCT (user_id, alias_key);
alter table public.precise_cache add constraint precise_cache_cache_key_key UNIQUE (cache_key);
alter table public.push_sends add constraint push_sends_user_id_kind_lapse_key_key UNIQUE (user_id, kind, lapse_key);
alter table public.research_kb add constraint research_kb_url_key UNIQUE (url);
alter table public.research_kb_pending add constraint research_kb_pending_url_key UNIQUE (url);
alter table public.user_food_cache add constraint user_food_cache_user_id_canonical_key_key UNIQUE (user_id, canonical_key);
alter table public.user_profiles add constraint user_profiles_clerk_user_id_key UNIQUE (clerk_user_id);
alter table public.weekly_reports add constraint weekly_reports_user_id_week_start_key UNIQUE (user_id, week_start);
alter table food_memory_private.alias_rejections add constraint alias_rejections_pkey PRIMARY KEY (user_id, canonical_key, alias);
alter table food_memory_private.user_food_versions add constraint user_food_versions_pkey PRIMARY KEY (id);
alter table public.admin_users add constraint admin_users_pkey PRIMARY KEY (clerk_user_id);
alter table public.agent_review_log add constraint agent_review_log_pkey PRIMARY KEY (id);
alter table public.anon_plan_usage add constraint anon_plan_usage_pkey PRIMARY KEY (id);
alter table public.body_measurements add constraint body_measurements_pkey PRIMARY KEY (user_id, measured_on, site);
alter table public.bug_reports add constraint bug_reports_pkey PRIMARY KEY (id);
alter table public.coach_memory add constraint coach_memory_pkey PRIMARY KEY (id);
alter table public.coach_memory_seen add constraint coach_memory_seen_pkey PRIMARY KEY (user_id, source_id);
alter table public.coach_program_phase_metric_logs add constraint coach_program_phase_metric_logs_pkey PRIMARY KEY (id);
alter table public.coach_program_phase_metrics add constraint coach_program_phase_metrics_pkey PRIMARY KEY (id);
alter table public.coach_program_phases add constraint coach_program_phases_pkey PRIMARY KEY (id);
alter table public.coach_programs add constraint coach_programs_pkey PRIMARY KEY (id);
alter table public.coach_traces add constraint coach_traces_pkey PRIMARY KEY (id);
alter table public.coach_trials add constraint coach_trials_pkey PRIMARY KEY (clerk_user_id);
alter table public.coupon_batches add constraint coupon_batches_pkey PRIMARY KEY (id);
alter table public.coupons add constraint coupons_pkey PRIMARY KEY (code);
alter table public.daily_metrics add constraint daily_metrics_pkey PRIMARY KEY (user_id, metric_date, metric_type);
alter table public.daily_suggestions add constraint daily_suggestions_pkey PRIMARY KEY (user_id, day);
alter table public.drona_behaviours add constraint drona_behaviours_pkey PRIMARY KEY (user_id, week_start, behaviour);
alter table public.drona_cards add constraint drona_cards_pkey PRIMARY KEY (id);
alter table public.drona_change_outcome_facts add constraint drona_change_outcome_facts_pkey PRIMARY KEY (change_id);
alter table public.drona_day_facts add constraint drona_day_facts_pkey PRIMARY KEY (user_id, day);
alter table public.drona_exercise_habit_week_facts add constraint drona_exercise_habit_week_facts_pkey PRIMARY KEY (user_id, week_start, exercise_id);
alter table public.drona_exercise_week_facts add constraint drona_exercise_week_facts_pkey PRIMARY KEY (user_id, week_start, exercise_id);
alter table public.drona_facts_runs add constraint drona_facts_runs_pkey PRIMARY KEY (user_id);
alter table public.drona_moment_asks add constraint drona_moment_asks_pkey PRIMARY KEY (user_id, source_id);
alter table public.drona_muscle_week_facts add constraint drona_muscle_week_facts_pkey PRIMARY KEY (user_id, week_start, muscle, role);
alter table public.drona_pick_muscle_day_facts add constraint drona_pick_muscle_day_facts_pkey PRIMARY KEY (user_id, day, muscle, role);
alter table public.drona_plan_muscle_week_facts add constraint drona_plan_muscle_week_facts_pkey PRIMARY KEY (user_id, week_start, muscle, role);
alter table public.drona_recovery_day_facts add constraint drona_recovery_day_facts_pkey PRIMARY KEY (user_id, day);
alter table public.drona_signals add constraint drona_signals_pkey PRIMARY KEY (user_id, week_start, signal);
alter table public.drona_training_day_facts add constraint drona_training_day_facts_pkey PRIMARY KEY (user_id, day);
alter table public.drona_week_facts add constraint drona_week_facts_pkey PRIMARY KEY (user_id, week_start);
alter table public.drona_word_facts add constraint drona_word_facts_pkey PRIMARY KEY (user_id, kind, source_id);
alter table public.drona_word_signals add constraint drona_word_signals_pkey PRIMARY KEY (user_id, week_start, signal);
alter table public.exercises add constraint exercises_pkey PRIMARY KEY (id);
alter table public.food_bar_traces add constraint food_bar_traces_pkey PRIMARY KEY (id);
alter table public.food_card_lines add constraint food_card_lines_pkey PRIMARY KEY (card_id, version, line_id);
alter table public.food_cards add constraint food_cards_pkey PRIMARY KEY (id);
alter table public.food_log_stats add constraint food_log_stats_pkey PRIMARY KEY (food_id);
alter table public.food_servings add constraint food_servings_pkey PRIMARY KEY (id);
alter table public.food_thread_turns add constraint food_thread_turns_pkey PRIMARY KEY (thread_id, seq);
alter table public.food_threads add constraint food_threads_pkey PRIMARY KEY (id);
alter table public.foods add constraint foods_pkey PRIMARY KEY (id);
alter table public.form_checks add constraint form_checks_pkey PRIMARY KEY (id);
alter table public.founding_tier_claims add constraint founding_tier_claims_pkey PRIMARY KEY (tier);
alter table public.free_goal_builds add constraint free_goal_builds_pkey PRIMARY KEY (user_id);
alter table public.free_phase_builds add constraint free_phase_builds_pkey PRIMARY KEY (user_id);
alter table public.health_cardio_imports add constraint health_cardio_imports_pkey PRIMARY KEY (user_id, source, external_id);
alter table public.ingest_checkpoints add constraint ingest_checkpoints_pkey PRIMARY KEY (source);
alter table public.invite_codes add constraint invite_codes_pkey PRIMARY KEY (code);
alter table public.invite_events add constraint invite_events_pkey PRIMARY KEY (id);
alter table public.invite_failed_tries add constraint invite_failed_tries_pkey PRIMARY KEY (id);
alter table public.invite_redemptions add constraint invite_redemptions_pkey PRIMARY KEY (clerk_user_id);
alter table public.kv_store_89faff51 add constraint kv_store_89faff51_pkey PRIMARY KEY (key);
alter table public.marketing_waitlist add constraint marketing_waitlist_pkey PRIMARY KEY (id);
alter table public.mcp_requests add constraint mcp_requests_pkey PRIMARY KEY (user_id, request_id);
alter table public.mcp_traces add constraint mcp_traces_pkey PRIMARY KEY (id);
alter table public.meal_entries add constraint meal_entries_pkey PRIMARY KEY (id);
alter table public.meals add constraint meals_pkey PRIMARY KEY (id);
alter table public.model_pricing add constraint model_pricing_pkey PRIMARY KEY (model);
alter table public.parse_traces add constraint parse_traces_pkey PRIMARY KEY (id);
alter table public.plan_changes add constraint plan_changes_pkey PRIMARY KEY (id);
alter table public.precise_alias add constraint precise_alias_pkey PRIMARY KEY (id);
alter table public.precise_cache add constraint precise_cache_pkey PRIMARY KEY (id);
alter table public.publisher_denylist add constraint publisher_denylist_pkey PRIMARY KEY (pattern);
alter table public.push_sends add constraint push_sends_pkey PRIMARY KEY (id);
alter table public.push_tokens add constraint push_tokens_pkey PRIMARY KEY (token);
alter table public.readiness_parts add constraint readiness_parts_pkey PRIMARY KEY (user_id, metric_date);
alter table public.redemption_codes add constraint redemption_codes_pkey PRIMARY KEY (code);
alter table public.research_kb add constraint research_kb_pkey PRIMARY KEY (id);
alter table public.research_kb_pending add constraint research_kb_pending_pkey PRIMARY KEY (id);
alter table public.routine_exercises add constraint routine_exercises_pkey PRIMARY KEY (id);
alter table public.routine_snapshots add constraint routine_snapshots_pkey PRIMARY KEY (routine_id);
alter table public.routines add constraint routines_pkey PRIMARY KEY (id);
alter table public.saved_meal_items add constraint saved_meal_items_pkey PRIMARY KEY (id);
alter table public.saved_meals add constraint saved_meals_pkey PRIMARY KEY (id);
alter table public.server_tool_pricing add constraint server_tool_pricing_pkey PRIMARY KEY (provider, tool);
alter table public.timezone_names add constraint timezone_names_pkey PRIMARY KEY (name);
alter table public.token_usage_log add constraint token_usage_log_pkey PRIMARY KEY (id);
alter table public.user_day_targets add constraint user_day_targets_pkey PRIMARY KEY (user_id, day);
alter table public.user_exercise_notes add constraint user_exercise_notes_pkey PRIMARY KEY (user_id, exercise_id);
alter table public.user_food_cache add constraint user_food_cache_pkey PRIMARY KEY (id);
alter table public.user_lift_stats add constraint user_lift_stats_pkey PRIMARY KEY (user_id, exercise_id);
alter table public.user_nutrition_stats add constraint user_nutrition_stats_pkey PRIMARY KEY (user_id, day);
alter table public.user_profiles add constraint user_profiles_pkey PRIMARY KEY (id);
alter table public.user_target_history add constraint user_target_history_pkey PRIMARY KEY (user_id, effective_from);
alter table public.user_volume_stats add constraint user_volume_stats_pkey PRIMARY KEY (user_id, muscle_group, week_start);
alter table public.weekly_reports add constraint weekly_reports_pkey PRIMARY KEY (id);
alter table public.workout_exercise_notes add constraint workout_exercise_notes_pkey PRIMARY KEY (workout_id, exercise_id);
alter table public.workout_sets add constraint workout_sets_pkey PRIMARY KEY (id);
alter table public.workouts add constraint workouts_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX idx_agent_review_log_unique_pending ON public.agent_review_log USING btree (pending_id) WHERE (reverted_at IS NULL);
CREATE UNIQUE INDEX coach_program_phase_metrics_one_hero ON public.coach_program_phase_metrics USING btree (phase_id) WHERE is_hero;
CREATE UNIQUE INDEX coach_programs_one_active ON public.coach_programs USING btree (user_id) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX drona_cards_user_moment_key ON public.drona_cards USING btree (user_id, moment_day, topic) WHERE (slot = 'moment'::text);
CREATE UNIQUE INDEX drona_cards_user_week_slot_key ON public.drona_cards USING btree (user_id, week_start, slot) WHERE (slot <> 'moment'::text);
CREATE UNIQUE INDEX uq_exercises_owner_name ON public.exercises USING btree (lower(name), created_by) WHERE (created_by IS NOT NULL);
CREATE UNIQUE INDEX uq_exercises_global_name ON public.exercises USING btree (lower(name)) WHERE (created_by IS NULL);
CREATE UNIQUE INDEX uq_food_servings_default ON public.food_servings USING btree (food_id) WHERE is_default;
CREATE UNIQUE INDEX uq_food_servings_label ON public.food_servings USING btree (food_id, lower(label));
CREATE UNIQUE INDEX uq_food_thread_turns_client ON public.food_thread_turns USING btree (thread_id, client_id, role) WHERE (client_id IS NOT NULL);
CREATE UNIQUE INDEX uq_foods_name_global ON public.foods USING btree (lower(name)) WHERE (created_by IS NULL);
CREATE UNIQUE INDEX uq_foods_name_owner ON public.foods USING btree (lower(name), created_by) WHERE (created_by IS NOT NULL);
CREATE UNIQUE INDEX idx_invite_codes_owner_email ON public.invite_codes USING btree (lower(owner_email));
CREATE UNIQUE INDEX idx_invite_codes_referral_owner ON public.invite_codes USING btree (owner_clerk_user_id) WHERE (source = 'referral'::text);
CREATE UNIQUE INDEX marketing_waitlist_email_lower_idx ON public.marketing_waitlist USING btree (lower(email));
CREATE UNIQUE INDEX uq_meal_entries_client_id_slot ON public.meal_entries USING btree (client_id, meal_id, "position") WHERE (client_id IS NOT NULL);
CREATE UNIQUE INDEX uq_meals_client_id ON public.meals USING btree (user_id, client_id) WHERE (client_id IS NOT NULL);
CREATE UNIQUE INDEX user_food_versions_one_current ON food_memory_private.user_food_versions USING btree (cache_id) WHERE (state = 'current'::text);
CREATE UNIQUE INDEX uq_workouts_client_id ON public.workouts USING btree (user_id, client_id) WHERE (client_id IS NOT NULL);

alter table food_memory_private.user_food_versions add constraint user_food_versions_cache_id_fkey FOREIGN KEY (cache_id) REFERENCES user_food_cache(id) ON DELETE CASCADE;
alter table public.agent_review_log add constraint agent_review_log_new_kb_id_fkey FOREIGN KEY (new_kb_id) REFERENCES research_kb(id) ON DELETE SET NULL;
alter table public.agent_review_log add constraint agent_review_log_pending_id_fkey FOREIGN KEY (pending_id) REFERENCES research_kb_pending(id) ON DELETE RESTRICT;
alter table public.coach_program_phase_metric_logs add constraint coach_program_phase_metric_logs_metric_id_fkey FOREIGN KEY (metric_id) REFERENCES coach_program_phase_metrics(id) ON DELETE CASCADE;
alter table public.coach_program_phase_metrics add constraint coach_program_phase_metrics_phase_id_fkey FOREIGN KEY (phase_id) REFERENCES coach_program_phases(id) ON DELETE CASCADE;
alter table public.coach_program_phase_metrics add constraint coach_program_phase_metrics_program_id_fkey FOREIGN KEY (program_id) REFERENCES coach_programs(id) ON DELETE CASCADE;
alter table public.coach_program_phases add constraint coach_program_phases_program_id_fkey FOREIGN KEY (program_id) REFERENCES coach_programs(id) ON DELETE CASCADE;
alter table public.coach_program_phases add constraint coach_program_phases_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL;
alter table public.coupons add constraint coupons_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES coupon_batches(id);
alter table public.daily_suggestions add constraint daily_suggestions_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL;
alter table public.daily_suggestions add constraint daily_suggestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_behaviours add constraint drona_behaviours_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_cards add constraint drona_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_change_outcome_facts add constraint drona_change_outcome_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_day_facts add constraint drona_day_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_exercise_habit_week_facts add constraint drona_exercise_habit_week_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_exercise_week_facts add constraint drona_exercise_week_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_facts_runs add constraint drona_facts_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_moment_asks add constraint drona_moment_asks_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_muscle_week_facts add constraint drona_muscle_week_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_pick_muscle_day_facts add constraint drona_pick_muscle_day_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_plan_muscle_week_facts add constraint drona_plan_muscle_week_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_recovery_day_facts add constraint drona_recovery_day_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_signals add constraint drona_signals_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_training_day_facts add constraint drona_training_day_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_week_facts add constraint drona_week_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.drona_word_facts add constraint drona_word_facts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.food_card_lines add constraint food_card_lines_card_id_fkey FOREIGN KEY (card_id) REFERENCES food_cards(id) ON DELETE CASCADE;
alter table public.food_cards add constraint food_cards_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES food_threads(id) ON DELETE CASCADE;
alter table public.food_log_stats add constraint food_log_stats_food_id_fkey FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE CASCADE;
alter table public.food_servings add constraint food_servings_food_id_fkey FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE CASCADE;
alter table public.food_thread_turns add constraint food_thread_turns_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES food_threads(id) ON DELETE CASCADE;
alter table public.form_checks add constraint form_checks_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE SET NULL;
alter table public.health_cardio_imports add constraint health_cardio_imports_workout_id_fkey FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE SET NULL;
alter table public.invite_codes add constraint invite_codes_owner_clerk_user_id_fkey FOREIGN KEY (owner_clerk_user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE SET NULL;
alter table public.invite_events add constraint invite_events_code_fkey FOREIGN KEY (code) REFERENCES invite_codes(code) ON DELETE CASCADE;
alter table public.invite_redemptions add constraint invite_redemptions_clerk_user_id_fkey FOREIGN KEY (clerk_user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.invite_redemptions add constraint invite_redemptions_code_fkey FOREIGN KEY (code) REFERENCES invite_codes(code);
alter table public.mcp_requests add constraint mcp_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.mcp_traces add constraint mcp_traces_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.meal_entries add constraint meal_entries_food_id_fkey FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE SET NULL;
alter table public.meal_entries add constraint meal_entries_meal_id_fkey FOREIGN KEY (meal_id) REFERENCES meals(id) ON DELETE CASCADE;
alter table public.meal_entries add constraint meal_entries_serving_id_fkey FOREIGN KEY (serving_id) REFERENCES food_servings(id) ON DELETE SET NULL;
alter table public.plan_changes add constraint plan_changes_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.precise_alias add constraint precise_alias_row_id_fkey FOREIGN KEY (row_id) REFERENCES precise_cache(id) ON DELETE CASCADE;
alter table public.precise_cache add constraint precise_cache_promoted_food_id_fkey FOREIGN KEY (promoted_food_id) REFERENCES foods(id) ON DELETE SET NULL;
alter table public.push_sends add constraint push_sends_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.push_tokens add constraint push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.readiness_parts add constraint readiness_parts_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.research_kb add constraint research_kb_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES research_kb(id) ON DELETE SET NULL;
alter table public.routine_exercises add constraint routine_exercises_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE;
alter table public.routine_exercises add constraint routine_exercises_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE;
alter table public.routine_snapshots add constraint routine_snapshots_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE CASCADE;
alter table public.routines add constraint routines_program_phase_id_fkey FOREIGN KEY (program_phase_id) REFERENCES coach_program_phases(id) ON DELETE SET NULL;
alter table public.saved_meal_items add constraint saved_meal_items_food_id_fkey FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE SET NULL;
alter table public.saved_meal_items add constraint saved_meal_items_saved_meal_id_fkey FOREIGN KEY (saved_meal_id) REFERENCES saved_meals(id) ON DELETE CASCADE;
alter table public.user_day_targets add constraint user_day_targets_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.user_exercise_notes add constraint user_exercise_notes_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE;
alter table public.user_food_cache add constraint user_food_cache_food_id_fkey FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE SET NULL;
alter table public.user_food_cache add constraint user_food_cache_last_entry_id_fkey FOREIGN KEY (last_entry_id) REFERENCES meal_entries(id) ON DELETE CASCADE;
alter table public.user_target_history add constraint user_target_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES user_profiles(clerk_user_id) ON DELETE CASCADE;
alter table public.workout_exercise_notes add constraint workout_exercise_notes_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE;
alter table public.workout_exercise_notes add constraint workout_exercise_notes_workout_id_fkey FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE;
alter table public.workout_sets add constraint workout_sets_exercise_id_fkey FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE;
alter table public.workout_sets add constraint workout_sets_workout_id_fkey FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE;
alter table public.workouts add constraint workouts_routine_id_fkey FOREIGN KEY (routine_id) REFERENCES routines(id) ON DELETE SET NULL;

-- Triggers that fire on a user_profiles delete (part of an account delete),
-- read with live_tables.gen.sql part 2.
CREATE OR REPLACE FUNCTION public.delete_food_threads_on_profile_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from public.food_threads where user_id = old.clerk_user_id;
  return old;
end;
$function$
;
CREATE TRIGGER trg_delete_food_threads_on_profile_delete AFTER DELETE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION delete_food_threads_on_profile_delete();
CREATE OR REPLACE FUNCTION public.delete_free_goal_builds_on_profile_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from public.free_goal_builds where user_id = old.clerk_user_id;
  return old;
end;
$function$
;
CREATE TRIGGER trg_delete_free_goal_builds_on_profile_delete AFTER DELETE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION delete_free_goal_builds_on_profile_delete();
CREATE OR REPLACE FUNCTION public.delete_traces_on_profile_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  delete from public.food_bar_traces where user_id = old.clerk_user_id;
  delete from public.parse_traces where user_id = old.clerk_user_id;
  return old;
end;
$function$
;
CREATE TRIGGER trg_delete_traces_on_profile_delete AFTER DELETE ON public.user_profiles FOR EACH ROW EXECUTE FUNCTION delete_traces_on_profile_delete();
