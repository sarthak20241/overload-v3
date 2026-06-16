-- Coach Drona moved off claude-sonnet-4-20250514 (retired by Anthropic on
-- 2026-06-15 → 404 not_found_error) onto claude-sonnet-4-6. Add the pricing
-- row so token_usage_log cost accounting keeps resolving — same rates as
-- Sonnet 4. Old rows stay priced under their original model name.
insert into model_pricing (model, provider, input_per_million_usd, output_per_million_usd, cache_read_per_million_usd, cache_creation_per_million_usd) values
  ('claude-sonnet-4-6', 'anthropic', 3.00, 15.00, 0.30, 3.75)
on conflict (model) do update set
  input_per_million_usd          = excluded.input_per_million_usd,
  output_per_million_usd         = excluded.output_per_million_usd,
  cache_read_per_million_usd     = excluded.cache_read_per_million_usd,
  cache_creation_per_million_usd = excluded.cache_creation_per_million_usd,
  updated_at                     = now();
