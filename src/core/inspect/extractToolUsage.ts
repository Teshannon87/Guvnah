import type { ChatRequest } from "../../types/index.js";
import { countTokens } from "../tokens/countTokens.js";

export interface ToolUsageEntry {
  tool_name: string;
  shipped: boolean;
  invoked: boolean;
  description_tokens: number;
  description_preview: string | null;
}

const DESCRIPTION_PREVIEW_CHARS = 200;

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
  const shipped = new Map<
    string,
    { schemaTokens: number; description: string | null }
  >();

  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      const info = extractShipped(t);
      if (info.name) mergeShipped(shipped, info);
    }
  }
  if (Array.isArray(req.functions)) {
    for (const f of req.functions) {
      const info = extractShipped(f);
      if (info.name) mergeShipped(shipped, info);
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
    const s = shipped.get(name);
    entries.push({
      tool_name: name,
      shipped: !!s,
      invoked: invoked.has(name),
      description_tokens: s?.schemaTokens ?? 0,
      description_preview: s?.description ?? null,
    });
  }
  return entries;
}

function mergeShipped(
  shipped: Map<string, { schemaTokens: number; description: string | null }>,
  info: { name: string; schemaTokens: number; description: string | null },
): void {
  const existing = shipped.get(info.name);
  if (existing) {
    existing.schemaTokens += info.schemaTokens;
    if (!existing.description && info.description) {
      existing.description = info.description;
    }
    return;
  }
  shipped.set(info.name, {
    schemaTokens: info.schemaTokens,
    description: info.description,
  });
}

interface ShippedInfo {
  name: string;
  schemaTokens: number;
  description: string | null;
}

function extractShipped(raw: unknown): ShippedInfo | { name: null; schemaTokens: 0; description: null } {
  if (!raw || typeof raw !== "object") return { name: null, schemaTokens: 0, description: null };
  const obj = raw as Record<string, unknown>;
  // OpenAI: { type: "function", function: { name, description, parameters } }
  const fn = obj.function as Record<string, unknown> | undefined;
  let name: string | null = null;
  let description: string | null = null;
  if (fn && typeof fn.name === "string") {
    name = fn.name;
    if (typeof fn.description === "string") description = fn.description;
  }
  // Anthropic-style or legacy functions array: { name, description, parameters }
  if (!name && typeof obj.name === "string") {
    name = obj.name;
    if (typeof obj.description === "string") description = obj.description;
  }
  if (!name) return { name: null, schemaTokens: 0, description: null };
  const schemaTokens = countTokens(JSON.stringify(raw));
  const preview = description
    ? truncate(description.replace(/\s+/g, " ").trim(), DESCRIPTION_PREVIEW_CHARS)
    : null;
  return { name, schemaTokens, description: preview };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function readToolCallName(call: unknown): string | null {
  if (!call || typeof call !== "object") return null;
  const obj = call as Record<string, unknown>;
  const fn = obj.function as Record<string, unknown> | undefined;
  if (fn && typeof fn.name === "string") return fn.name;
  if (typeof obj.name === "string") return obj.name;
  return null;
}
