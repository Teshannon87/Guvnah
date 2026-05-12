import type { ContextFlag } from "../../types/index.js";

export function detectOversizedContext(
  promptTokens: number,
  threshold: number,
): ContextFlag | null {
  if (promptTokens <= threshold) return null;
  const severity = promptTokens > threshold * 1.5 ? "high" : "medium";
  return {
    flag_type: "oversized_context",
    severity,
    message: `Total prompt tokens (${promptTokens.toLocaleString()}) exceed the configured budget of ${threshold.toLocaleString()}.`,
    estimated_tokens_involved: promptTokens,
    suggestion:
      "Trim the largest categories first; consider summarizing conversation history and lazily injecting tool schemas.",
  };
}
