import { describe, expect, it, beforeEach } from "vitest";
import { defaultConfig } from "../src/core/config/defaultConfig.js";
import { RunTracker, formatRunSummary } from "../src/core/notify/runTracker.js";
import type { GuvnahConfig } from "../src/core/config/schema.js";
import type { ContextFlag } from "../src/types/index.js";

function flag(
  type: ContextFlag["flag_type"],
  tokens: number,
  suggestion = `fix-${type}`,
): ContextFlag {
  return {
    flag_type: type,
    severity: "medium",
    message: `msg ${type}`,
    estimated_tokens_involved: tokens,
    suggestion,
  };
}

function fastConfig(overrides?: Partial<GuvnahConfig["notifications"]["cli"]["end_of_run"]>): GuvnahConfig {
  return {
    ...defaultConfig,
    notifications: {
      cli: {
        ...defaultConfig.notifications.cli,
        end_of_run: {
          enabled: true,
          idle_seconds: 1,
          sweep_interval_seconds: 1,
          ...overrides,
        },
      },
    },
  };
}

describe("RunTracker.recordCall + sweep", () => {
  let now = 0;
  const nowFn = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it("emits one summary after the run goes idle, then forgets the run", () => {
    const out: string[] = [];
    const tracker = new RunTracker(fastConfig(), (line) => out.push(line), nowFn);

    tracker.recordCall({
      runId: "r1",
      model: "gpt-4o-mini",
      promptTokens: 100,
      responseTokens: 50,
      flags: [flag("cache_hostile_prefix", 80)],
    });
    tracker.recordCall({
      runId: "r1",
      model: "gpt-4o-mini",
      promptTokens: 200,
      responseTokens: 60,
      flags: [flag("cache_hostile_prefix", 90), flag("tool_bloat", 1200)],
    });

    // Not yet idle.
    now += 500;
    tracker.sweep();
    expect(out).toHaveLength(0);

    // Cross the idle threshold (1s).
    now += 1_500;
    tracker.sweep();
    expect(out).toHaveLength(1);

    const summary = out[0];
    expect(summary).toContain("📊 Run summary: r1");
    expect(summary).toContain("2 calls");
    expect(summary).toContain("300 in / 110 out");
    expect(summary).toMatch(/\$0\.0+\d/);
    expect(summary).toContain("cache_hostile_prefix (2)");
    expect(summary).toContain("tool_bloat (1)");
    expect(summary).toContain("Top fix: cache_hostile_prefix in 2/2 calls");

    // Second sweep should not re-emit.
    now += 5_000;
    tracker.sweep();
    expect(out).toHaveLength(1);
  });

  it("emits 'No bloat flags' summary when no flags were raised", () => {
    const out: string[] = [];
    const tracker = new RunTracker(fastConfig(), (line) => out.push(line), nowFn);

    tracker.recordCall({
      runId: "clean",
      model: "gpt-4o-mini",
      promptTokens: 10,
      responseTokens: 10,
      flags: [],
    });
    now += 2_000;
    tracker.sweep();

    expect(out).toHaveLength(1);
    expect(out[0]).toContain("No bloat flags raised");
  });

  it("emits 'cost unknown' when the model has no pricing source", () => {
    const out: string[] = [];
    const tracker = new RunTracker(fastConfig(), (line) => out.push(line), nowFn);

    tracker.recordCall({
      runId: "mystery",
      model: "totally-made-up-model",
      promptTokens: 100,
      responseTokens: 50,
      flags: [],
    });
    now += 2_000;
    tracker.sweep();

    expect(out[0]).toContain("cost unknown");
  });

  it("breaks flag-frequency ties by total tokens involved", () => {
    const out: string[] = [];
    const tracker = new RunTracker(fastConfig(), (line) => out.push(line), nowFn);

    tracker.recordCall({
      runId: "tie",
      model: "gpt-4o-mini",
      promptTokens: 10,
      responseTokens: 10,
      flags: [flag("memory_bloat", 100), flag("tool_bloat", 5000)],
    });
    now += 2_000;
    tracker.sweep();

    expect(out[0]).toContain("Top fix: tool_bloat");
  });

  it("is a no-op when end_of_run.enabled is false", () => {
    const cfg = fastConfig({ enabled: false });
    const out: string[] = [];
    const tracker = new RunTracker(cfg, (line) => out.push(line), nowFn);

    tracker.recordCall({
      runId: "r",
      model: "gpt-4o-mini",
      promptTokens: 100,
      responseTokens: 50,
      flags: [flag("memory_bloat", 100)],
    });
    now += 10_000;
    tracker.sweep();

    expect(out).toHaveLength(0);
  });

  it("flushes in-flight runs on stop()", () => {
    const out: string[] = [];
    const tracker = new RunTracker(fastConfig(), (line) => out.push(line), nowFn);

    tracker.recordCall({
      runId: "shutting-down",
      model: "gpt-4o-mini",
      promptTokens: 100,
      responseTokens: 50,
      flags: [],
    });

    tracker.stop();
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("📊 Run summary: shutting-down");
  });
});

describe("formatRunSummary edge cases", () => {
  it("singularizes '1 call'", () => {
    const summary = formatRunSummary({
      runId: "r",
      calls: 1,
      promptTokens: 1,
      responseTokens: 1,
      costUsd: 0.01,
      costKnown: true,
      flagCounts: new Map(),
      flagTokenTotals: new Map(),
      topSuggestion: new Map(),
      lastSeenAt: 0,
      lastModel: null,
    });
    expect(summary).toContain("1 call ");
  });
});
