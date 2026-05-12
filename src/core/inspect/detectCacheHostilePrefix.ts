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
