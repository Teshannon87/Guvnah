export interface ModelPricing {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
}

// Baseline prices in USD per 1M tokens.
// Sourced from public provider pricing pages. These values change; users can
// override via `pricing:` in guvnah.context.yaml, and the resolver will also
// prefer a synced OpenRouter catalog if present.
export const BASELINE_PRICING: ModelPricing[] = [
  { model: "gpt-4o", input_per_mtok: 2.5, output_per_mtok: 10.0 },
  { model: "gpt-4o-mini", input_per_mtok: 0.15, output_per_mtok: 0.6 },
  { model: "gpt-4.1", input_per_mtok: 2.0, output_per_mtok: 8.0 },
  { model: "gpt-4.1-mini", input_per_mtok: 0.4, output_per_mtok: 1.6 },
  { model: "o3-mini", input_per_mtok: 1.1, output_per_mtok: 4.4 },
  { model: "claude-haiku-4-5", input_per_mtok: 1.0, output_per_mtok: 5.0 },
  { model: "claude-sonnet-4-5", input_per_mtok: 3.0, output_per_mtok: 15.0 },
  { model: "claude-sonnet-4-6", input_per_mtok: 3.0, output_per_mtok: 15.0 },
  { model: "claude-opus-4-7", input_per_mtok: 15.0, output_per_mtok: 75.0 },
  { model: "gemini-2.5-flash", input_per_mtok: 0.3, output_per_mtok: 2.5 },
  { model: "gemini-2.5-flash-lite", input_per_mtok: 0.1, output_per_mtok: 0.4 },
  { model: "gemini-2.5-pro", input_per_mtok: 1.25, output_per_mtok: 10.0 },
  { model: "llama-3.3-70b", input_per_mtok: 0.59, output_per_mtok: 0.79 },
];
