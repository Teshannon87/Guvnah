import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config/defaultConfig.js";
import {
  estimateCostUsd,
  resolvePricing,
} from "../src/core/pricing/resolvePricing.js";
import { formatCostLine } from "../src/core/notify/cliNotifier.js";
import type { GuvnahConfig } from "../src/core/config/schema.js";

describe("resolvePricing", () => {
  it("returns config override when provided", () => {
    const cfg: GuvnahConfig = {
      ...defaultConfig,
      pricing: {
        ...defaultConfig.pricing,
        overrides: [
          { model: "custom-x", input_per_mtok: 1.23, output_per_mtok: 4.56 },
        ],
      },
    };
    const r = resolvePricing("custom-x", cfg);
    expect(r.source).toBe("config");
    expect(r.pricing?.input_per_mtok).toBe(1.23);
    expect(r.pricing?.output_per_mtok).toBe(4.56);
  });

  it("falls back to baseline for known model names", () => {
    const r = resolvePricing("gpt-4o-mini", defaultConfig);
    expect(r.source).toBe("baseline");
    expect(r.pricing?.model).toBe("gpt-4o-mini");
  });

  it("normalizes provider-prefixed model names against the baseline", () => {
    const r = resolvePricing("openai/gpt-4o", defaultConfig);
    expect(r.source).toBe("baseline");
    expect(r.pricing?.model).toBe("gpt-4o");
  });

  it("returns unknown source for models not in any list", () => {
    const r = resolvePricing("totally-made-up-model", defaultConfig);
    expect(r.source).toBe("unknown");
    expect(r.pricing).toBeNull();
  });

  it("returns unknown for empty input", () => {
    const r = resolvePricing(null, defaultConfig);
    expect(r.source).toBe("unknown");
  });
});

describe("estimateCostUsd", () => {
  it("computes cost from per-Mtok rates", () => {
    const cost = estimateCostUsd(
      { model: "x", input_per_mtok: 2.0, output_per_mtok: 10.0 },
      1_000_000,
      500_000,
    );
    expect(cost).toBeCloseTo(2.0 + 5.0, 6);
  });
});

describe("formatCostLine", () => {
  it("includes coin, tokens, dollar cost, model, and run id", () => {
    const line = formatCostLine(
      {
        model: "gpt-4o-mini",
        promptTokens: 4820,
        responseTokens: 312,
        runId: "run-001",
      },
      defaultConfig,
    );
    expect(line).not.toBeNull();
    expect(line!).toContain("🪙");
    expect(line!).toContain("4,820 in / 312 out");
    expect(line!).toMatch(/\$0\.0\d+/);
    expect(line!).toContain("gpt-4o-mini");
    expect(line!).toContain("run=run-001");
  });

  it("shows cost unknown when model is missing or unpriced", () => {
    const line = formatCostLine(
      {
        model: "totally-made-up-model",
        promptTokens: 100,
        responseTokens: 50,
        runId: "run-002",
      },
      defaultConfig,
    );
    expect(line).not.toBeNull();
    expect(line!).toContain("cost unknown");
  });

  it("returns null when CLI notifications are disabled", () => {
    const cfg: GuvnahConfig = {
      ...defaultConfig,
      notifications: {
        cli: { enabled: false, coin_emoji: "🪙" },
      },
    };
    const line = formatCostLine(
      { model: "gpt-4o-mini", promptTokens: 1, responseTokens: 1, runId: "r" },
      cfg,
    );
    expect(line).toBeNull();
  });

  it("tags non-baseline sources with the source name", () => {
    const cfg: GuvnahConfig = {
      ...defaultConfig,
      pricing: {
        ...defaultConfig.pricing,
        overrides: [
          { model: "override-me", input_per_mtok: 5, output_per_mtok: 10 },
        ],
      },
    };
    const line = formatCostLine(
      { model: "override-me", promptTokens: 1000, responseTokens: 500, runId: "r" },
      cfg,
    );
    expect(line).toContain("[config]");
  });
});
