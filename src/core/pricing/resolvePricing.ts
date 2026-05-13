import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import type { GuvnahConfig } from "../config/schema.js";
import { BASELINE_PRICING, type ModelPricing } from "./baseline.js";

type PricingSource = "config" | "openrouter" | "baseline" | "unknown";

export interface ResolvedPricing {
  pricing: ModelPricing | null;
  source: PricingSource;
}

const aliasMap: Record<string, string> = {
  "openai/gpt-4o": "gpt-4o",
  "openai/gpt-4o-mini": "gpt-4o-mini",
  "openai/gpt-4.1": "gpt-4.1",
  "openai/gpt-4.1-mini": "gpt-4.1-mini",
  "openai/o3-mini": "o3-mini",
  "anthropic/claude-haiku-4-5": "claude-haiku-4-5",
  "anthropic/claude-sonnet-4-5": "claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-6": "claude-sonnet-4-6",
  "anthropic/claude-opus-4-7": "claude-opus-4-7",
  "google/gemini-2.5-flash": "gemini-2.5-flash",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  "meta-llama/llama-3.3-70b": "llama-3.3-70b",
};

function normalize(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return aliasMap[trimmed] ?? trimmed.replace(/^(openai|anthropic|google|meta-llama)\//, "");
}

function readOpenRouterCache(dbPath: string): ModelPricing[] {
  const cachePath = resolvePath(dirname(dbPath), "openrouter-models.json");
  if (!existsSync(cachePath)) return [];
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Array<{
      id?: string;
      pricing?: { prompt?: string | number; completion?: string | number };
    }>;
    const out: ModelPricing[] = [];
    for (const m of raw) {
      if (!m.id || !m.pricing) continue;
      const prompt = Number(m.pricing.prompt);
      const completion = Number(m.pricing.completion);
      if (!Number.isFinite(prompt) || !Number.isFinite(completion)) continue;
      // OpenRouter exposes per-token prices. Convert to per-Mtok.
      out.push({
        model: m.id,
        input_per_mtok: prompt * 1_000_000,
        output_per_mtok: completion * 1_000_000,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function find(list: ModelPricing[], model: string): ModelPricing | null {
  const target = normalize(model);
  for (const p of list) {
    if (p.model.toLowerCase() === model.toLowerCase()) return p;
    if (normalize(p.model) === target) return p;
  }
  return null;
}

export function resolvePricing(
  model: string | null | undefined,
  config: GuvnahConfig,
): ResolvedPricing {
  if (!model) return { pricing: null, source: "unknown" };

  const overrides = config.pricing?.overrides ?? [];
  const fromConfig = find(overrides, model);
  if (fromConfig) return { pricing: fromConfig, source: "config" };

  if (config.pricing?.use_openrouter_cache !== false) {
    const openrouter = readOpenRouterCache(config.database.path);
    const hit = find(openrouter, model);
    if (hit) return { pricing: hit, source: "openrouter" };
  }

  if (config.pricing?.use_baseline !== false) {
    const baseline = find(BASELINE_PRICING, model);
    if (baseline) return { pricing: baseline, source: "baseline" };
  }

  return { pricing: null, source: "unknown" };
}

export function estimateCostUsd(
  pricing: ModelPricing,
  promptTokens: number,
  responseTokens: number,
): number {
  const input = (promptTokens / 1_000_000) * pricing.input_per_mtok;
  const output = (responseTokens / 1_000_000) * pricing.output_per_mtok;
  return input + output;
}

// Anthropic prompt-caching multipliers. Per Anthropic docs (as of 2026):
//   cache write = 1.25x the base input rate
//   cache read  = 0.10x the base input rate
// These multipliers are universal across Claude models, so we apply them at
// the cost-calc layer rather than per-model.
const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 1.25;
const ANTHROPIC_CACHE_READ_MULTIPLIER = 0.10;

export function estimateCostUsdWithCache(args: {
  pricing: ModelPricing;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  const { pricing, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = args;
  // Anthropic's input_tokens excludes cache tokens; cache fields are billed separately.
  const inputCost = (inputTokens / 1_000_000) * pricing.input_per_mtok;
  const cacheWriteCost =
    (cacheCreationTokens / 1_000_000) * pricing.input_per_mtok * ANTHROPIC_CACHE_WRITE_MULTIPLIER;
  const cacheReadCost =
    (cacheReadTokens / 1_000_000) * pricing.input_per_mtok * ANTHROPIC_CACHE_READ_MULTIPLIER;
  const outputCost = (outputTokens / 1_000_000) * pricing.output_per_mtok;
  return inputCost + cacheWriteCost + cacheReadCost + outputCost;
}
