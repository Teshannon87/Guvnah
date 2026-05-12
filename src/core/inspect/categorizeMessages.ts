import type { Category, ChatMessage } from "../../types/index.js";
import type { GuvnahConfig } from "../config/schema.js";
import { messageText, countMessageTokens } from "../tokens/estimateChatTokens.js";

export interface CategorizedMessage {
  index: number;
  category: Category;
  tokens: number;
  text: string;
}

function containsAny(haystack: string, needles: string[]): boolean {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (n && lower.includes(n.toLowerCase())) return true;
  }
  return false;
}

export function categorizeMessage(
  msg: ChatMessage,
  cfg: GuvnahConfig["categories"],
): Category {
  const role = msg.role;
  if (cfg.system.role_patterns.includes(role)) return "system";
  if (role === "tool" || role === "function") return "toolOutput";

  const text = messageText(msg);

  if (containsAny(text, cfg.tool_output.keyword_patterns)) return "toolOutput";
  if (containsAny(text, cfg.tools.keyword_patterns)) return "tools";
  if (containsAny(text, cfg.memory.keyword_patterns)) return "memory";
  if (cfg.history.role_patterns.includes(role)) return "history";
  return "unknown";
}

export function categorizeMessages(
  messages: ChatMessage[],
  cfg: GuvnahConfig["categories"],
): CategorizedMessage[] {
  return messages.map((msg, index) => ({
    index,
    category: categorizeMessage(msg, cfg),
    tokens: countMessageTokens(msg),
    text: messageText(msg),
  }));
}
