import type Database from "better-sqlite3";
import type { ToolUsageAggregate } from "../../types/index.js";
import { aggregateToolUsage } from "../../db/queries.js";
import {
  HERMES_TOOL_TO_TOOLSET,
  toolsetFor,
} from "../inspect/hermesToolsetMap.js";

export type RecommendationKind =
  | "unused_tool"
  | "rarely_used_tool"
  | "unused_toolset"
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

  recs.push(...recommendForToolsets(toolStats, minShipped));
  recs.push(...recommendForTools(toolStats, minShipped, recs));
  recs.push(...recommendForCacheThrash(db, input));
  recs.push(...recommendForSystemBloat(db, input));

  return recs;
}

function recommendForToolsets(
  stats: ToolUsageAggregate[],
  minShipped: number,
): Recommendation[] {
  // Group observed-shipped tools by toolset
  const byToolset = new Map<
    string,
    {
      total_wasted: number;
      tools: ToolUsageAggregate[];
      any_invoked: boolean;
      max_shipped: number;
    }
  >();
  for (const s of stats) {
    if (s.shipped_calls < minShipped) continue;
    const ts = toolsetFor(s.tool_name);
    if (!ts) continue;
    let bucket = byToolset.get(ts);
    if (!bucket) {
      bucket = {
        total_wasted: 0,
        tools: [],
        any_invoked: false,
        max_shipped: 0,
      };
      byToolset.set(ts, bucket);
    }
    bucket.tools.push(s);
    bucket.total_wasted += s.wasted_tokens_est;
    if (s.invoked_calls > 0) bucket.any_invoked = true;
    if (s.shipped_calls > bucket.max_shipped) bucket.max_shipped = s.shipped_calls;
  }

  const expectedToolsByToolset = new Map<string, Set<string>>();
  for (const [tool, ts] of Object.entries(HERMES_TOOL_TO_TOOLSET)) {
    let set = expectedToolsByToolset.get(ts);
    if (!set) {
      set = new Set();
      expectedToolsByToolset.set(ts, set);
    }
    set.add(tool);
  }

  const recs: Recommendation[] = [];
  for (const [ts, bucket] of byToolset.entries()) {
    if (bucket.any_invoked) continue;
    const expected = expectedToolsByToolset.get(ts) ?? new Set();
    const observed = new Set(bucket.tools.map((t) => t.tool_name));
    // Every observed tool in this toolset is unused; the toolset itself
    // can be safely disabled at the toolset level.
    const observedNames = bucket.tools.map((t) => `${t.tool_name} (${formatNumber(t.wasted_tokens_est)} tok wasted)`);
    const missingFromObserved = [...expected].filter((n) => !observed.has(n));
    const missingNote = missingFromObserved.length
      ? ` Other tools in this toolset not seen in window: ${missingFromObserved.join(", ")}.`
      : "";
    recs.push({
      id: `rec-unused-toolset-${ts}`,
      kind: "unused_toolset",
      severity: bucket.total_wasted > 5000 ? "high" : "medium",
      title: `Toolset "${ts}" never invoked (${bucket.tools.length} tools, ~${formatNumber(bucket.total_wasted)} tokens wasted)`,
      reason: `All observed tools in the "${ts}" toolset were shipped on ${bucket.max_shipped}+ calls but never invoked.${missingNote}`,
      suggested_action: actionDisableToolset(ts),
      revert_hint: revertHintToolset(ts),
      evidence: {
        toolset: ts,
        tools_observed: observedNames,
        max_shipped_calls: bucket.max_shipped,
        total_wasted_tokens_est: bucket.total_wasted,
      },
    });
  }
  return recs;
}

function recommendForTools(
  stats: ToolUsageAggregate[],
  minShipped: number,
  existingRecs: Recommendation[],
): Recommendation[] {
  const coveredByToolset = new Set<string>();
  for (const r of existingRecs) {
    if (r.kind === "unused_toolset") {
      const obs = r.evidence.tools_observed;
      if (Array.isArray(obs)) {
        for (const entry of obs as string[]) {
          // entry format: "tool_name (XX tok wasted)"
          const name = entry.split(" (")[0];
          if (name) coveredByToolset.add(name);
        }
      }
    }
  }

  const recs: Recommendation[] = [];
  for (const s of stats) {
    if (s.shipped_calls < minShipped) continue;
    if (coveredByToolset.has(s.tool_name)) continue;
    const toolset = toolsetFor(s.tool_name);
    const descLine = s.description_preview ? ` — "${s.description_preview}"` : "";

    if (s.invoked_calls === 0) {
      recs.push({
        id: `rec-unused-${s.tool_name}`,
        kind: "unused_tool",
        severity: s.wasted_tokens_est > 5000 ? "high" : "medium",
        title: `Tool "${s.tool_name}" never invoked${descLine}`,
        reason: `Description shipped on ${s.shipped_calls} of ${s.total_calls} calls; never called. Estimated waste: ${formatNumber(s.wasted_tokens_est)} tokens.`,
        suggested_action: actionDisableTool(s.tool_name, toolset),
        revert_hint: revertHintTool(s.tool_name, toolset),
        evidence: {
          shipped_calls: s.shipped_calls,
          invoked_calls: s.invoked_calls,
          avg_description_tokens: s.avg_description_tokens,
          wasted_tokens_est: s.wasted_tokens_est,
          description_preview: s.description_preview,
          hermes_toolset: toolset,
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
        title: `Tool "${s.tool_name}" used in <5% of calls${descLine}`,
        reason: `Description shipped on ${s.shipped_calls} calls; invoked ${s.invoked_calls} time(s) (${(ratio * 100).toFixed(1)}%). Consider lazy-loading.`,
        suggested_action:
          "Move this tool behind an intent gate so the description is only shipped when the agent is likely to need it. For Hermes the closest equivalent is disabling the parent toolset and re-enabling per session.",
        revert_hint: "Re-add the tool name to the always-on tool list.",
        evidence: {
          shipped_calls: s.shipped_calls,
          invoked_calls: s.invoked_calls,
          invocation_ratio: ratio,
          description_preview: s.description_preview,
          hermes_toolset: toolset,
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

function actionDisableTool(name: string, toolset: string | null): string {
  if (toolset) {
    return `Hermes has no per-tool disable. The closest action is disabling the whole "${toolset}" toolset (which contains "${name}" and possibly other tools). See the parent toolset recommendation if it exists, or edit /root/.hermes/config.yaml: add "${toolset}" to \`agent.disabled_toolsets:\` and restart hermes-gateway.`;
  }
  return `Remove "${name}" from the upstream agent's enabled-tools list. For Hermes: edit /root/.hermes/config.yaml \`agent.disabled_toolsets:\` (note: only toolsets are gateable, not individual tools) and restart hermes-gateway.`;
}

function revertHintTool(name: string, toolset: string | null): string {
  if (toolset) {
    return `Remove "${toolset}" from \`agent.disabled_toolsets:\` in /root/.hermes/config.yaml and restart hermes-gateway.`;
  }
  return `Restore from config.yaml.bak.<timestamp> or re-add "${name}" to the upstream config and restart.`;
}

function actionDisableToolset(ts: string): string {
  return `Add "${ts}" to \`agent.disabled_toolsets:\` in /root/.hermes/config.yaml and restart hermes-gateway. This quiets the tools without deleting them — re-enable any time by removing the entry. Suggested commands:\n  cp /root/.hermes/config.yaml /root/.hermes/config.yaml.bak.$(date +%Y%m%d-%H%M%S)\n  python3 -c "import yaml; d=yaml.safe_load(open('/root/.hermes/config.yaml')); d['agent']['disabled_toolsets']=sorted(set(d['agent'].get('disabled_toolsets',[])+['${ts}'])); open('/root/.hermes/config.yaml','w').write(yaml.dump(d, sort_keys=False))"\n  systemctl restart hermes-gateway`;
}

function revertHintToolset(ts: string): string {
  return `Remove "${ts}" from \`agent.disabled_toolsets:\` in /root/.hermes/config.yaml and restart hermes-gateway, or restore from the .bak.<timestamp> backup created above.`;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}
