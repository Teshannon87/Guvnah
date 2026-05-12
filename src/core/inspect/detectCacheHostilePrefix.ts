import type { ChatMessage, ContextFlag } from "../../types/index.js";
import { shortHash } from "../logging/hash.js";
import { countTokens } from "../tokens/countTokens.js";
import { messageText } from "../tokens/estimateChatTokens.js";

export function computeStablePrefixHash(
  messages: ChatMessage[],
  windowTokens: number,
): string {
  let buffer = "";
  let tokens = 0;
  for (const msg of messages) {
    const text = `${msg.role}:${messageText(msg)}\n`;
    const t = countTokens(text);
    if (tokens + t > windowTokens) {
      const remaining = Math.max(0, windowTokens - tokens);
      buffer += text.slice(0, remaining * 4);
      break;
    }
    buffer += text;
    tokens += t;
  }
  return shortHash(buffer);
}

export function detectCacheHostilePrefix(
  currentHash: string,
  previousHash: string | null,
  windowTokens: number,
): ContextFlag | null {
  if (!previousHash) return null;
  if (previousHash === currentHash) return null;
  return {
    flag_type: "cache_hostile_prefix",
    severity: "medium",
    message: `Stable prefix (first ~${windowTokens.toLocaleString()} tokens) changed since the previous call in this run.`,
    estimated_tokens_involved: windowTokens,
    suggestion:
      "Keep persona/tool index identical across calls and move dynamic state later in the prompt so provider prefix caching can hit.",
  };
}

/**
 * Cross-run thrash: if the agent has shipped multiple distinct stable prefixes
 * within the cache TTL window (~5 min), every call pays a cache miss.
 */
export function detectCacheThrash(
  currentHash: string,
  recentDistinctHashes: string[],
  opts: { windowMinutes: number; thresholdDistinct: number; windowTokens: number },
): ContextFlag | null {
  const merged = new Set<string>(recentDistinctHashes);
  merged.add(currentHash);
  if (merged.size < opts.thresholdDistinct) return null;
  return {
    flag_type: "cache_thrash",
    severity: merged.size >= opts.thresholdDistinct + 2 ? "high" : "medium",
    message: `Stable prefix changed ${merged.size} times across calls in the last ${opts.windowMinutes} minute(s). Provider prompt cache (~5 min TTL) is being busted on every call.`,
    estimated_tokens_involved: opts.windowTokens * merged.size,
    suggestion:
      "Identify which preamble segment changes between calls (system / tool index / memory) and move volatile content (timestamps, run IDs, ephemeral state) to the tail of the user message.",
  };
}
