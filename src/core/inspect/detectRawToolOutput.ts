import type { ContextFlag } from "../../types/index.js";

export function detectRawToolOutput(
  toolOutputTokens: number,
  threshold: number,
): ContextFlag | null {
  if (toolOutputTokens <= threshold) return null;
  return {
    flag_type: "raw_tool_output_bloat",
    severity: toolOutputTokens > threshold * 2 ? "high" : "medium",
    message: `Raw tool output consumed ${toolOutputTokens.toLocaleString()} tokens (budget ${threshold.toLocaleString()}).`,
    estimated_tokens_involved: toolOutputTokens,
    suggestion:
      "Summarize tool outputs before reinjecting them; only keep the slice the model actually needs.",
  };
}
