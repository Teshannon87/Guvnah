import type { ChatRequest } from "../../types/index.js";
import { countTokens } from "../tokens/countTokens.js";

export interface ToolUsageEntry {
  tool_name: string;
  shipped: boolean;
  invoked: boolean;
  description_tokens: number;
}

/**
 * Returns one entry per distinct tool seen in this request, with:
 *   - shipped: tool description was included in req.tools / req.functions
 *   - invoked: tool was called somewhere in req.messages (assistant.tool_calls or function_call)
 *   - description_tokens: tokens spent shipping this tool's schema
 *
 * The invoked signal here looks at HISTORY in this request, not the response.
 * Across many calls in a run that captures the actual invocation pattern.
 */
export function extractToolUsage(req: ChatRequest): ToolUsageEntry[] {
  const shipped = new Map<string, number>();

  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      const { name, schemaTokens } = extractShipped(t);
      if (name) shipped.set(name, (shipped.get(name) ?? 0) + schemaTokens);
    }
  }
  if (Array.isArray(req.functions)) {
    for (const f of req.functions) {
      const { name, schemaTokens } = extractShipped(f);
      if (name) shipped.set(name, (shipped.get(name) ?? 0) + schemaTokens);
    }
  }

  const invoked = new Set<string>();
  for (const msg of req.messages ?? []) {
    if (Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        const name = readToolCallName(call);
        if (name) invoked.add(name);
      }
    }
    const legacy = (msg as { function_call?: { name?: string } }).function_call;
    if (legacy?.name) invoked.add(legacy.name);
  }

  const allNames = new Set<string>([...shipped.keys(), ...invoked]);
  const entries: ToolUsageEntry[] = [];
  for (const name of allNames) {
    entries.push({
      tool_name: name,
      shipped: shipped.has(name),
      invoked: invoked.has(name),
      description_tokens: shipped.get(name) ?? 0,
    });
  }
  return entries;
}

function extractShipped(raw: unknown): { name: string | null; schemaTokens: number } {
  if (!raw || typeof raw !== "object") return { name: null, schemaTokens: 0 };
  const obj = raw as Record<string, unknown>;
  // OpenAI: { type: "function", function: { name, description, parameters } }
  const fn = obj.function as Record<string, unknown> | undefined;
  let name: string | null = null;
  if (fn && typeof fn.name === "string") name = fn.name;
  // Anthropic-style or legacy functions array: { name, description, parameters }
  if (!name && typeof obj.name === "string") name = obj.name;
  if (!name) return { name: null, schemaTokens: 0 };
  const schemaTokens = countTokens(JSON.stringify(raw));
  return { name, schemaTokens };
}

function readToolCallName(call: unknown): string | null {
  if (!call || typeof call !== "object") return null;
  const obj = call as Record<string, unknown>;
  const fn = obj.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === "string") return fn.name;
  if (typeof obj.name === "string") return obj.name;
  return null;
}
