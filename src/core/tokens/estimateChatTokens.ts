import type { ChatMessage, ChatRequest } from "../../types/index.js";
import { countTokens } from "./countTokens.js";

const PER_MESSAGE_OVERHEAD = 4;
const REPLY_PRIMER = 3;

export function messageText(msg: ChatMessage): string {
  const parts: string[] = [];
  if (typeof msg.content === "string") {
    parts.push(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block && typeof block === "object" && typeof block.text === "string") {
        parts.push(block.text);
      } else if (block) {
        parts.push(JSON.stringify(block));
      }
    }
  }
  if (msg.name) parts.push(msg.name);
  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    parts.push(JSON.stringify(msg.tool_calls));
  }
  return parts.join("\n");
}

export function countMessageTokens(msg: ChatMessage): number {
  const text = messageText(msg);
  return countTokens(text) + PER_MESSAGE_OVERHEAD;
}

export function countToolSchemaTokens(req: ChatRequest): number {
  let total = 0;
  if (Array.isArray(req.tools)) total += countTokens(JSON.stringify(req.tools));
  if (Array.isArray(req.functions)) total += countTokens(JSON.stringify(req.functions));
  return total;
}

export function estimateChatTokens(req: ChatRequest): number {
  let total = 0;
  for (const msg of req.messages ?? []) {
    total += countMessageTokens(msg);
  }
  total += countToolSchemaTokens(req);
  total += REPLY_PRIMER;
  return total;
}
