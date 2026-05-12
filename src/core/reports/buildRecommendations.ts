import type Database from "better-sqlite3";
import type { ToolUsageAggregate } from "../../types/index.js";
import { aggregateToolUsage } from "../../db/queries.js";

export type RecommendationKind =
  | "unused_tool"
  | "rarely_used_tool"
  | "cache_thrash"
  | "system_prompt_bloat"
  | "tool_block_bloat";

export interface Recommendation {
  id: string;
  kind: RecommendationKind;
  severity: "low" | "medium" | "high";
  title: string;
  reason: string;
  suggested_action: string;
  revert_hint: string;
  evidence: Record<string, unknown>;
}

export interface RecommendationsInput {
  agentId?: string;
  sinceIso?: string;
  minShippedCalls?: number;
  minRunsForUnusedFlag?: number;
}

export function buildRecommendations(
  db: Database.Database,
  input: RecommendationsInput = {},
): Recommendation[] {
  const recs: Recommendation[] = [];
  const minShipped = input.minShippedCalls ?? 5;

  const toolStats = aggregateToolUsage(db, {
    agentId: input.agentId,
    sinceIso: input.sinceIso,
    limit: 500,
  });

  recs.push(...recommendForTools(toolStats, minShipped));
  recs.push(...recommendForCacheThrash(db, input));
  recs.push(...recommendForSystemBloat(db, input));

  return recs;
}

function recommendForTools(
  stats: ToolUsageAggregate[],
  minShipped: number,
): Recommendation[] {
  const recs: Recommendation[] = [];
  for (const s of stats) {
    if (s.shipped_calls < minShipped) continue;
    if (s.invoked_calls === 0) {
      recs.push({
        id: `rec-unused-${s.tool_name}`,
        kind: "unused_tool",
        severity: s.wasted_tokens_est > 5000 ? "high" : "medium",
        title: `Tool "${s.tool_name}" never invoked`,
        reason: `Description shipped on ${s.shipped_calls} of ${s.total_calls} calls; never called. Estimated waste: ${formatNumber(s.wasted_tokens_est)} tokens.`,
        suggested_action: actionDisableTool(s.tool_name),
        revert_hint: revertHintTool(s.tool_name),
        evidence: {
          shipped_calls: s.shipped_calls,
          invoked_calls: s.invoked_calls,
          avg_description_tokens: s.avg_description_tokens,
          wasted_tokens_est: s.wasted_tokens_est,
        },
      });
      continue;
    }
    const ratio = s.invoked_calls / s.shipped_calls;
    if (ratio < 0.05 && s.shipped_calls >= minShipped * 2) {
      recs.push({
        id: `rec-rare-${s.tool_name}`,
        kind: "rarely_used_tool",
        severity: "low",
        title: `Tool "${s.tool_name}" used in <5% of calls`,
        reason: `Description shipped on ${s.shipped_calls} calls; invoked ${s.invoked_calls} time(s) (${(ratio * 100).toFixed(1)}%). Consider lazy-loading.`,
        suggested_action:
          "Move this tool behind an intent gate so the description is only shipped when the agent is likely to need it.",
        revert_hint: "Re-add the tool name to the always-on tool list.",
        evidence: {
          shipped_calls: s.shipped_calls,
          invoked_calls: s.invoked_calls,
          invocation_ratio: ratio,
        },
      });
    }
  }
  return recs;
}

function recommendForCacheThrash(
  db: Database.Database,
  input: RecommendationsInput,
): Recommendation[] {
  const sinceIso =
    input.sinceIso ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const agentClause = input.agentId ? `AND c.agent_id = @agentId` : "";
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_flags f
       JOIN llm_calls c ON c.id = f.llm_call_id
       WHERE f.flag_type = 'cache_thrash'
         AND f.created_at >= @sinceIso
         ${agentClause}`,
    )
    .get({ sinceIso, agentId: input.agentId ?? null }) as { n: number };
  if (!rows.n) return [];
  return [
    {
      id: `rec-cache-thrash`,
      kind: "cache_thrash",
      severity: rows.n > 10 ? "high" : "medium",
      title: `Prompt cache being busted (${rows.n} thrash events)`,
      reason: `Stable prefix changed multiple times within the cache TTL window across ${rows.n} call(s). Every cache miss re-bills the full prefix.`,
      suggested_action:
        "Diff two consecutive requests' first ~4K tokens. Move anything volatile (timestamps, run IDs, ephemeral memory) into the user message tail.",
      revert_hint:
        "No revert needed — this is a guidance recommendation, not an apply action.",
      evidence: { thrash_events: rows.n, since: sinceIso },
    },
  ];
}

function recommendForSystemBloat(
  db: Database.Database,
  input: RecommendationsInput,
): Recommendation[] {
  const sinceIso =
    input.sinceIso ?? new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  const agentClause = input.agentId ? `AND agent_id = @agentId` : "";
  const rows = db
    .prepare(
      `SELECT COUNT(*) AS n, CAST(AVG(system_tokens) AS INTEGER) AS avg_sys
       FROM llm_calls
       WHERE created_at >= @sinceIso ${agentClause}`,
    )
    .get({ sinceIso, agentId: input.agentId ?? null }) as {
    n: number;
    avg_sys: number | null;
  };
  if (!rows.n || !rows.avg_sys || rows.avg_sys < 5000) return [];
  return [
    {
      id: `rec-system-bloat`,
      kind: "system_prompt_bloat",
      severity: rows.avg_sys > 10_000 ? "high" : "medium",
      title: `System prompt averaging ${formatNumber(rows.avg_sys)} tokens`,
      reason: `Across ${rows.n} call(s), average system block is ${formatNumber(rows.avg_sys)} tokens. Likely contains duplicated SOUL / persona content also present in memory.`,
      suggested_action:
        "Run `guvnah-context report --run <id>` to see system breakdown, then dedupe persona content between system prompt and memory layer.",
      revert_hint:
        "Backup is created automatically if you later run an apply action.",
      evidence: { calls: rows.n, avg_system_tokens: rows.avg_sys },
    },
  ];
}

function actionDisableTool(name: string): string {
  return `Remove "${name}" from the upstream agent's enabled-tools list. For Hermes: edit /root/.hermes/config.yaml \`enabled_tools:\` and restart hermes-gateway.`;
}

function revertHintTool(name: string): string {
  return `Restore from config.yaml.bak.<timestamp> or re-add "${name}" to enabled_tools and restart.`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}
