import type { ContextFlag } from "../../types/index.js";

export function detectToolBloat(
  toolTokens: number,
  threshold: number,
): ContextFlag | null {
  if (toolTokens <= threshold) return null;
  return {
    flag_type: "tool_bloat",
    severity: toolTokens > threshold * 2 ? "high" : "medium",
    message: `Tool/skill descriptions consumed ${toolTokens.toLocaleString()} tokens (budget ${threshold.toLocaleString()}).`,
    estimated_tokens_involved: toolTokens,
    suggestion:
      "Inject a compact tool index first, then expand only the schemas the agent actually needs for this turn.",
  };
}
