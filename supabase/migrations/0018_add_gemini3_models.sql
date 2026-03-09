-- Add Gemini 3 models to the gateway catalog
-- Pricing based on Google AI published rates (USD per 1K tokens)

INSERT INTO models (id, provider, name, input_cost, output_cost, context_window, capabilities, min_plan, sort_order)
VALUES
  ('google/gemini-3-flash', 'google', 'Gemini 3 Flash', 0.0001, 0.0004, 1000000, '["tool_call","reasoning","vision"]', 'free', 1),
  ('google/gemini-3.1-pro', 'google', 'Gemini 3.1 Pro', 0.00125, 0.005, 2000000, '["tool_call","reasoning","vision"]', 'free', 2)
ON CONFLICT (id) DO NOTHING;

-- Refresh the materialized view so the gateway picks up the new models
SELECT refresh_gateway_config();
