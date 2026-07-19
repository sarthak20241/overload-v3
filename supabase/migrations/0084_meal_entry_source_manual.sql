-- 0084: allow source='manual' on meal_entries.
--
-- Users can now correct an AI-parsed line (serving, quantity, or the macros
-- themselves) before adding it. Those numbers are the USER's, not the
-- catalog's or the model's, so they get their own provenance value instead of
-- masquerading as a catalog match or "Drona's estimate". The diary can then
-- show a corrected line honestly, and eval/analytics can tell how often the
-- parser needed fixing.
alter table public.meal_entries drop constraint if exists meal_entries_source_check;
alter table public.meal_entries add constraint meal_entries_source_check
  check (source is null or source in ('catalog', 'off', 'web', 'estimate', 'manual'));
