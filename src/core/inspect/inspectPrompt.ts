import type {
  CategoryBreakdown,
  ChatRequest,
  ContextFlag,
  PromptInspection,
} from "../../types/index.js";
import type { GuvnahConfig } from "../config/schema.js";
import { shortHash } from "../logging/hash.js";
import { countToolSchemaTokens, estimateChatTokens } from "../tokens/estimateChatTokens.js";
import { categorizeMessages } from "./categorizeMessages.js";
import { detectRepeatedBlocks } from "./detectRepeatedBlocks.js";
import { detectOversizedContext } from "./detectOversizedContext.js";
import { detectToolBloat } from "./detectToolBloat.js";
import { detectMemoryBloat } from "./detectMemoryBloat.js";
import { detectHistoryBloat } from "./detectHistoryBloat.js";
import { detectRawToolOutput } from "./detectRawToolOutput.js";
import {
  computeStablePrefixHash,
  detectCacheHostilePrefix,
  detectCacheThrash,
} from "./detectCacheHostilePrefix.js";
import { extractToolUsage } from "./extractToolUsage.js";

export interface InspectPromptOptions {
  config: GuvnahConfig;
  priorBlockOccurrences?: (blockHash: string) => number;
  previousStablePrefixHash?: string | null;
  recentDistinctPrefixHashes?: string[];
}

export function inspectPrompt(
  req: ChatRequest,
  opts: InspectPromptOptions,
): PromptInspection {
  const { config } = opts;
  const messages = Array.isArray(req.messages) ? req.messages : [];

  const categorized = categorizeMessages(messages, config.categories);

  const categories: CategoryBreakdown = {
    system: 0,
    tools: 0,
    memory: 0,
    history: 0,
    toolOutput: 0,
    unknown: 0,
  };
  let largestMessageTokens = 0;
  for (const m of categorized) {
    categories[m.category] += m.tokens;
    if (m.tokens > largestMessageTokens) largestMessageTokens = m.tokens;
  }
  categories.tools += countToolSchemaTokens(req);

  const promptTokens = estimateChatTokens(req);

  const flags: ContextFlag[] = [];

  const oversized = detectOversizedContext(
    promptTokens,
    config.detection.oversized_context_tokens,
  );
  if (oversized) flags.push(oversized);

  if (categories.system > config.token_budgets.max_system_tokens) {
    flags.push({
      flag_type: "large_system_prompt",
      severity:
        categories.system > config.token_budgets.max_system_tokens * 2
          ? "high"
          : "medium",
      message: `System/developer prompt consumed ${categories.system.toLocaleString()} tokens (budget ${config.token_budgets.max_system_tokens.toLocaleString()}).`,
      estimated_tokens_involved: categories.system,
      suggestion:
        "Move static persona/instructions into a cached preamble and keep dynamic state out of the system block.",
    });
  }

  const tool = detectToolBloat(categories.tools, config.token_budgets.max_tools_tokens);
  if (tool) flags.push(tool);

  const memory = detectMemoryBloat(
    categories.memory,
    config.token_budgets.max_memory_tokens,
  );
  if (memory) flags.push(memory);

  const history = detectHistoryBloat(
    categories.history,
    config.token_budgets.max_history_tokens,
  );
  if (history) flags.push(history);

  const toolOutput = detectRawToolOutput(
    categories.toolOutput,
    config.token_budgets.max_tool_output_tokens,
  );
  if (toolOutput) flags.push(toolOutput);

  if (largestMessageTokens > config.detection.large_message_tokens) {
    flags.push({
      flag_type: "large_single_message",
      severity:
        largestMessageTokens > config.detection.large_message_tokens * 2
          ? "high"
          : "medium",
      message: `A single message contained ${largestMessageTokens.toLocaleString()} tokens.`,
      estimated_tokens_involved: largestMessageTokens,
      suggestion:
        "Split or summarize this message; large monolithic blocks defeat caching and crowd out other context.",
    });
  }

  if (categories.unknown > config.detection.unknown_mass_tokens) {
    flags.push({
      flag_type: "unknown_context_mass",
      severity: "low",
      message: `${categories.unknown.toLocaleString()} tokens did not match any known category.`,
      estimated_tokens_involved: categories.unknown,
      suggestion:
        "Audit unclassified messages; consider tagging them or adjusting category keyword patterns in config.",
    });
  }

  const repeatedBlocks = detectRepeatedBlocks(
    categorized.map((c) => c.text),
    config.detection,
    opts.priorBlockOccurrences,
  );
  if (repeatedBlocks.length > 0) {
    const totalTokens = repeatedBlocks.reduce(
      (acc, b) => acc + b.occurrences * b.estimated_tokens,
      0,
    );
    const top = repeatedBlocks[0]!;
    flags.push({
      flag_type: "repeated_block",
      severity: totalTokens > config.detection.oversized_context_tokens / 4 ? "high" : "medium",
      message: `Detected ${repeatedBlocks.length} repeated block(s); top block (${top.estimated_tokens.toLocaleString()} tokens) appeared ${top.occurrences} times.`,
      estimated_tokens_involved: totalTokens,
      suggestion:
        "Move repeated content into a cached stable prefix or reference it by ID instead of duplicating each call.",
    });
  }

  const stablePrefixHash = computeStablePrefixHash(
    messages,
    config.detection.cache_prefix_window_tokens,
  );
  const cacheHostile = detectCacheHostilePrefix(
    stablePrefixHash,
    opts.previousStablePrefixHash ?? null,
    config.detection.cache_prefix_window_tokens,
  );
  if (cacheHostile) flags.push(cacheHostile);

  const cacheThrash = detectCacheThrash(
    stablePrefixHash,
    opts.recentDistinctPrefixHashes ?? [],
    {
      windowMinutes: config.detection.cache_thrash_window_minutes,
      thresholdDistinct: config.detection.cache_thrash_distinct_hashes,
      windowTokens: config.detection.cache_prefix_window_tokens,
    },
  );
  if (cacheThrash) flags.push(cacheThrash);

  const requestHash = shortHash(JSON.stringify({
    model: req.model,
    messages,
    tools: req.tools ?? null,
    functions: req.functions ?? null,
  }));

  const toolUsage = extractToolUsage(req);

  return {
    promptTokens,
    categories,
    flags,
    repeatedBlocks,
    stablePrefixHash,
    requestHash,
    largestMessageTokens,
    toolUsage,
  };
}
