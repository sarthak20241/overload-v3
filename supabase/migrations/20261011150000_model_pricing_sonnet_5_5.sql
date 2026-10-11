-- ai-coach and drona-cards move to claude-sonnet-5-5. compute_token_cost
-- returns 0 for a model with no row here, so without this every coach turn
-- would cost $0 in token_usage_log. Cache read 0.1x, 5-minute write 1.25x.
insert into model_pricing (model, provider, input_per_million_usd, output_per_million_usd, cache_read_per_million_usd, cache_creation_per_million_usd) values
  ('claude-sonnet-5-5', 'anthropic', 2.00, 10.00, 0.20, 2.50)
on conflict (model) do update set
  input_per_million_usd          = excluded.input_per_million_usd,
  output_per_million_usd         = excluded.output_per_million_usd,
  cache_read_per_million_usd     = excluded.cache_read_per_million_usd,
  cache_creation_per_million_usd = excluded.cache_creation_per_million_usd,
  updated_at                     = now();
