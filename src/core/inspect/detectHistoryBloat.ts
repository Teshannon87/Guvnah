import type { ContextFlag } from "../../types/index.js";

export function detectHistoryBloat(
  historyTokens: number,
  threshold: number,
): ContextFlag | null {
  if (historyTokens <= threshold) return null;
  return {
    flag_type: "history_bloat",
    severity: historyTokens > threshold * 2 ? "high" : "medium",
    message: `Conversation history consumed ${historyTokens.toLocaleString()} tokens (budget ${threshold.toLocaleString()}).`,
    estimated_tokens_involved: historyTokens,
    suggestion:
      "Summarize older turns or use a rolling window; keep only the last few user/assistant exchanges verbatim.",
  };
}
