-- Wave 1.2: per-DE model choice. ai_model_pricing (migration 094) now
-- doubles as the MODEL ALLOW-LIST: the profile UI offers exactly the
-- models priced here, so any model a tenant can pick has real cost
-- tracking from day one. Platform-managed (RLS: read-all, no direct
-- writes) — adding a model is a platform decision because it requires
-- verified pricing.
--
-- Prices verified against the current Anthropic price list (2026-07):
--   claude-sonnet-5   $3 / $15 per MTok  (already seeded by 094)
--   claude-haiku-4-5  $1 / $5            (fast + economical tier)
--   claude-opus-4-8   $5 / $25           (most capable Opus tier)
-- NOTE: my own earlier recollection of Opus at $15/$75 was WRONG (that
-- was the Opus 4.5-era price) — always verify prices, never recall them.

insert into ai_model_pricing (model_id, input_price_per_million, output_price_per_million)
values
  ('claude-sonnet-5', 3.00, 15.00),
  ('claude-haiku-4-5', 1.00, 5.00),
  ('claude-opus-4-8', 5.00, 25.00)
on conflict (model_id) do update set
  input_price_per_million = excluded.input_price_per_million,
  output_price_per_million = excluded.output_price_per_million,
  updated_at = now();
