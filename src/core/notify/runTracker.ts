import type { GuvnahConfig } from "../config/schema.js";
import type { ContextFlag, FlagType } from "../../types/index.js";
import { estimateCostUsd, resolvePricing } from "../pricing/resolvePricing.js";

export interface RunCallRecord {
  runId: string;
  model: string | null;
  promptTokens: number;
  responseTokens: number;
  flags: ContextFlag[];
}

interface RunAccumulator {
  runId: string;
  calls: number;
  promptTokens: number;
  responseTokens: number;
  costUsd: number;
  costKnown: boolean;
  flagCounts: Map<FlagType, number>;
  flagTokenTotals: Map<FlagType, number>;
  topSuggestion: Map<FlagType, string>;
  lastSeenAt: number;
  lastModel: string | null;
}

export type SummaryEmitter = (line: string) => void;

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

export function formatRunSummary(acc: RunAccumulator): string {
  const header = `📊 Run summary: ${acc.runId}`;
  const tokens = `${fmtNum(acc.promptTokens)} in / ${fmtNum(acc.responseTokens)} out`;
  const costPart = acc.costKnown ? ` → ${fmtUsd(acc.costUsd)} total` : " · cost unknown";
  const totals = `   ${acc.calls} call${acc.calls === 1 ? "" : "s"} · ${tokens}${costPart}`;

  if (acc.flagCounts.size === 0) {
    return [header, totals, "   No bloat flags raised on this run."].join("\n");
  }

  const ranked = [...acc.flagCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return (acc.flagTokenTotals.get(b[0]) ?? 0) - (acc.flagTokenTotals.get(a[0]) ?? 0);
  });
  const flagList = ranked.map(([type, count]) => `${type} (${count})`).join(", ");
  const [topType, topCount] = ranked[0]!;
  const topSuggestion = acc.topSuggestion.get(topType) ?? "";
  const tokensInvolved = acc.flagTokenTotals.get(topType) ?? 0;
  const savingsPart =
    tokensInvolved > 0 ? ` (est. ${fmtNum(tokensInvolved)} tokens involved)` : "";
  const topFixLine =
    `   Top fix: ${topType} in ${topCount}/${acc.calls} call${acc.calls === 1 ? "" : "s"}` +
    (topSuggestion ? ` — ${topSuggestion}` : "") +
    savingsPart;
  return [header, totals, `   Flags: ${flagList}`, topFixLine].join("\n");
}

export class RunTracker {
  private runs = new Map<string, RunAccumulator>();
  private interval: NodeJS.Timeout | null = null;
  private now: () => number;

  constructor(
    private readonly config: GuvnahConfig,
    private readonly emit: SummaryEmitter = (line) => process.stdout.write(line + "\n"),
    nowFn: () => number = Date.now,
  ) {
    this.now = nowFn;
  }

  recordCall(rec: RunCallRecord): void {
    if (!this.config.notifications.cli.end_of_run.enabled) return;
    let acc = this.runs.get(rec.runId);
    if (!acc) {
      acc = {
        runId: rec.runId,
        calls: 0,
        promptTokens: 0,
        responseTokens: 0,
        costUsd: 0,
        costKnown: false,
        flagCounts: new Map(),
        flagTokenTotals: new Map(),
        topSuggestion: new Map(),
        lastSeenAt: 0,
        lastModel: null,
      };
      this.runs.set(rec.runId, acc);
    }
    acc.calls += 1;
    acc.promptTokens += rec.promptTokens;
    acc.responseTokens += rec.responseTokens;
    acc.lastSeenAt = this.now();
    acc.lastModel = rec.model;

    if (rec.model) {
      const resolved = resolvePricing(rec.model, this.config);
      if (resolved.pricing) {
        acc.costUsd += estimateCostUsd(
          resolved.pricing,
          rec.promptTokens,
          rec.responseTokens,
        );
        acc.costKnown = true;
      }
    }

    for (const f of rec.flags) {
      acc.flagCounts.set(f.flag_type, (acc.flagCounts.get(f.flag_type) ?? 0) + 1);
      acc.flagTokenTotals.set(
        f.flag_type,
        (acc.flagTokenTotals.get(f.flag_type) ?? 0) + (f.estimated_tokens_involved || 0),
      );
      if (!acc.topSuggestion.has(f.flag_type) && f.suggestion) {
        acc.topSuggestion.set(f.flag_type, f.suggestion);
      }
    }
  }

  // Visible for tests.
  sweep(): void {
    const idleMs = this.config.notifications.cli.end_of_run.idle_seconds * 1000;
    const cutoff = this.now() - idleMs;
    for (const [runId, acc] of this.runs.entries()) {
      if (acc.lastSeenAt <= cutoff && acc.calls > 0) {
        try {
          this.emit(formatRunSummary(acc));
        } catch {
          // Notifier failures must never affect the proxy. Logged at call site.
        }
        this.runs.delete(runId);
      }
    }
  }

  start(): void {
    if (this.interval) return;
    if (!this.config.notifications.cli.end_of_run.enabled) return;
    const ms = this.config.notifications.cli.end_of_run.sweep_interval_seconds * 1000;
    this.interval = setInterval(() => this.sweep(), ms);
    if (typeof this.interval.unref === "function") this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    // Flush any runs still accumulating — useful on graceful shutdown so users
    // don't lose the summary for an in-flight run.
    for (const acc of this.runs.values()) {
      if (acc.calls > 0) {
        try {
          this.emit(formatRunSummary(acc));
        } catch {
          /* swallow */
        }
      }
    }
    this.runs.clear();
  }
}
