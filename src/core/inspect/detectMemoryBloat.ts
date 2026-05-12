import type { ContextFlag } from "../../types/index.js";

export function detectMemoryBloat(
  memoryTokens: number,
  threshold: number,
): ContextFlag | null {
  if (memoryTokens <= threshold) return null;
  return {
    flag_type: "memory_bloat",
    severity: memoryTokens > threshold * 2 ? "high" : "medium",
    message: `Memory/profile context consumed ${memoryTokens.toLocaleString()} tokens (budget ${threshold.toLocaleString()}).`,
    estimated_tokens_involved: memoryTokens,
    suggestion:
      "Retrieve only memories relevant to the current task instead of injecting the full profile every call.",
  };
}
