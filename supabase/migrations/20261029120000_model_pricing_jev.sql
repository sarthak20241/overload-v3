-- Jev (typesafe.ai) now writes token_usage_log rows (provider 'typesafe'),
-- one per answered call: food intent, parse checks, Tavily page relevance,
-- memory gates, the weekly word step. compute_token_cost returns 0 for a model
-- with no row here, so without this every Jev call would read as free.
-- typesafe.ai lists $42 per billion input tokens ($0.042/M); no output price is
-- published (checked 2026-10-29), so output is 0 until they print one.
insert into model_pricing (model, provider, input_per_million_usd, output_per_million_usd, cache_read_per_million_usd, cache_creation_per_million_usd) values
  ('jev-1.13.0', 'typesafe', 0.042, 0, null, null)
on conflict (model) do update set
  input_per_million_usd          = excluded.input_per_million_usd,
  output_per_million_usd         = excluded.output_per_million_usd,
  cache_read_per_million_usd     = excluded.cache_read_per_million_usd,
  cache_creation_per_million_usd = excluded.cache_creation_per_million_usd,
  updated_at                     = now();

-- Verify after applying:
--   select * from model_pricing where model = 'jev-1.13.0';
--   select compute_token_cost('jev-1.13.0', 1000000, 50, 0, 0);  -- 0.042
