-- parse_meal moved to claude-haiku-5-5. compute_token_cost returns 0 for a
-- model with no row here, so without this every food log would cost $0 in
-- token_usage_log. Rates are the up-to-100K-token card ($0.50 / $2.50 above
-- that; parse_meal prompts never get close). Cache read 0.1x, 5-minute write
-- 1.25x the input rate.
insert into model_pricing (model, provider, input_per_million_usd, output_per_million_usd, cache_read_per_million_usd, cache_creation_per_million_usd) values
  ('claude-haiku-5-5', 'anthropic', 0.10, 0.50, 0.01, 0.125)
on conflict (model) do update set
  input_per_million_usd          = excluded.input_per_million_usd,
  output_per_million_usd         = excluded.output_per_million_usd,
  cache_read_per_million_usd     = excluded.cache_read_per_million_usd,
  cache_creation_per_million_usd = excluded.cache_creation_per_million_usd,
  updated_at                     = now();
