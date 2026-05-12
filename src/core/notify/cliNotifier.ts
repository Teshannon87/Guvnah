import type { GuvnahConfig } from "../config/schema.js";
import { resolvePricing, estimateCostUsd } from "../pricing/resolvePricing.js";

export interface CostEvent {
  model: string | null;
  promptTokens: number;
  responseTokens: number;
  runId: string;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(6)}`;
}

export function formatCostLine(event: CostEvent, config: GuvnahConfig): string | null {
  if (!config.notifications.cli.enabled) return null;
  const coin = config.notifications.cli.coin_emoji;
  const tokens = `${fmtNum(event.promptTokens)} in / ${fmtNum(event.responseTokens)} out`;
  const meta = [event.model ?? "unknown-model", `run=${event.runId}`].join(", ");

  if (!event.model) {
    return `${coin} ${tokens} · cost unknown (${meta})`;
  }
  const resolved = resolvePricing(event.model, config);
  if (!resolved.pricing) {
    return `${coin} ${tokens} · cost unknown (${meta})`;
  }
  const cost = estimateCostUsd(resolved.pricing, event.promptTokens, event.responseTokens);
  const tag = resolved.source === "baseline" ? "" : ` [${resolved.source}]`;
  return `${coin} ${tokens} → ${fmtUsd(cost)} (${meta})${tag}`;
}

export function emitCostLine(event: CostEvent, config: GuvnahConfig): void {
  const line = formatCostLine(event, config);
  if (line) process.stdout.write(line + "\n");
}
