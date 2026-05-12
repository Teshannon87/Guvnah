import type Database from "better-sqlite3";
import {
  getCallsForRun,
  getFlagsForRun,
  getRepeatedBlocksForRun,
  getRun,
} from "../../db/queries.js";
import type {
  FlagRow,
  LlmCallRow,
  RepeatedBlockRow,
  RunRow,
} from "../../types/index.js";

export interface TopFlag {
  flag_type: string;
  count: number;
  total_tokens: number;
  top_message: string;
  top_suggestion: string;
  top_severity: string;
}

export interface LargestCall {
  call_id: string;
  prompt_tokens: number;
  biggest_category: string;
  biggest_category_tokens: number;
}

export interface RunReport {
  run: RunRow;
  calls: LlmCallRow[];
  flags: FlagRow[];
  repeatedBlocks: RepeatedBlockRow[];
  totals: {
    total_calls: number;
    total_prompt_tokens: number;
    total_response_tokens: number;
    categories: {
      system: number;
      tools: number;
      memory: number;
      history: number;
      toolOutput: number;
      unknown: number;
    };
  };
  topFlags: TopFlag[];
  largestCall: LargestCall | null;
  summary: string;
}

const FLAG_PRIORITY: Record<string, number> = {
  oversized_context: 10,
  tool_bloat: 9,
  repeated_block: 8,
  raw_tool_output_bloat: 7,
  memory_bloat: 6,
  history_bloat: 5,
  large_system_prompt: 4,
  cache_hostile_prefix: 3,
  large_single_message: 2,
  unknown_context_mass: 1,
};

function categoryWithMaxTokens(call: LlmCallRow): { name: string; tokens: number } {
  const entries: Array<[string, number]> = [
    ["system/developer", call.system_tokens],
    ["tools/skills", call.tool_tokens],
    ["memory/profile", call.memory_tokens],
    ["history", call.history_tokens],
    ["tool output", call.tool_output_tokens],
    ["unknown", call.unknown_tokens],
  ];
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0]!;
  return { name: top[0], tokens: top[1] };
}

function buildSummary(totals: RunReport["totals"], topFlags: TopFlag[]): string {
  const max = Math.max(
    totals.categories.system,
    totals.categories.tools,
    totals.categories.memory,
    totals.categories.history,
    totals.categories.toolOutput,
    totals.categories.unknown,
  );
  const worstCategory = (() => {
    if (max === 0) return "nothing in particular";
    if (max === totals.categories.tools) return "tools/skills";
    if (max === totals.categories.history) return "conversation history";
    if (max === totals.categories.toolOutput) return "raw tool output";
    if (max === totals.categories.memory) return "memory/profile";
    if (max === totals.categories.system) return "the system prompt";
    return "unclassified context";
  })();
  const severity = topFlags.length === 0
    ? "low"
    : topFlags.some((f) => f.top_severity === "high")
      ? "high"
      : "moderate";
  const flagSummary = topFlags.length === 0
    ? "no major flags fired."
    : `most waste appears to come from ${worstCategory}` +
      (topFlags.find((f) => f.flag_type === "repeated_block")
        ? " and repeated prompt blocks."
        : ".");
  return `Guvnah estimate: this run has ${severity} context bloat. ${flagSummary}`;
}

export function buildRunReport(db: Database.Database, runId: string): RunReport | null {
  const run = getRun(db, runId);
  if (!run) return null;
  const calls = getCallsForRun(db, runId);
  const flags = getFlagsForRun(db, runId);
  const repeatedBlocks = getRepeatedBlocksForRun(db, runId);

  const totals = {
    total_calls: calls.length,
    total_prompt_tokens: calls.reduce((a, c) => a + c.prompt_tokens, 0),
    total_response_tokens: calls.reduce((a, c) => a + c.response_tokens, 0),
    categories: {
      system: calls.reduce((a, c) => a + c.system_tokens, 0),
      tools: calls.reduce((a, c) => a + c.tool_tokens, 0),
      memory: calls.reduce((a, c) => a + c.memory_tokens, 0),
      history: calls.reduce((a, c) => a + c.history_tokens, 0),
      toolOutput: calls.reduce((a, c) => a + c.tool_output_tokens, 0),
      unknown: calls.reduce((a, c) => a + c.unknown_tokens, 0),
    },
  };

  const flagGroups = new Map<string, FlagRow[]>();
  for (const f of flags) {
    const group = flagGroups.get(f.flag_type) ?? [];
    group.push(f);
    flagGroups.set(f.flag_type, group);
  }
  const topFlags: TopFlag[] = [];
  for (const [type, items] of flagGroups) {
    const top = items.reduce((a, b) =>
      (a.estimated_tokens_involved ?? 0) >= (b.estimated_tokens_involved ?? 0) ? a : b,
    );
    topFlags.push({
      flag_type: type,
      count: items.length,
      total_tokens: items.reduce((a, b) => a + (b.estimated_tokens_involved ?? 0), 0),
      top_message: top.message,
      top_suggestion: top.suggestion ?? "",
      top_severity: top.severity,
    });
  }
  topFlags.sort(
    (a, b) =>
      (FLAG_PRIORITY[b.flag_type] ?? 0) - (FLAG_PRIORITY[a.flag_type] ?? 0) ||
      b.total_tokens - a.total_tokens,
  );

  const largestCall: LargestCall | null = (() => {
    if (calls.length === 0) return null;
    const biggest = calls.reduce((a, b) => (a.prompt_tokens >= b.prompt_tokens ? a : b));
    const cat = categoryWithMaxTokens(biggest);
    return {
      call_id: biggest.id,
      prompt_tokens: biggest.prompt_tokens,
      biggest_category: cat.name,
      biggest_category_tokens: cat.tokens,
    };
  })();

  const summary = buildSummary(totals, topFlags);

  return { run, calls, flags, repeatedBlocks, totals, topFlags, largestCall, summary };
}
