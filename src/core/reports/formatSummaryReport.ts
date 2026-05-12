import type { RunRow } from "../../types/index.js";

export function formatSummaryReport(runs: RunRow[]): string {
  if (runs.length === 0) return "No runs in this window.";
  const lines: string[] = [];
  lines.push(`Found ${runs.length} run(s).`);
  lines.push("");
  for (const r of runs) {
    lines.push(
      `- ${r.id}  agent=${r.agent_id}  calls=${r.total_calls}  prompt_tokens=${r.total_prompt_tokens.toLocaleString()}  flags=${r.total_flags}`,
    );
  }
  lines.push("");
  lines.push("Run `guvnah-context report --run <id>` to drill into a specific run.");
  return lines.join("\n");
}
