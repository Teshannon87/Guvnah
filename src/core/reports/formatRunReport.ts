import type { RunReport } from "./buildRunReport.js";

function n(v: number): string {
  return v.toLocaleString();
}

export function formatRunReport(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`Run: ${report.run.id}`);
  lines.push(`Agent: ${report.run.agent_id}`);
  if (report.run.task_id) lines.push(`Task: ${report.run.task_id} (${report.run.task_type ?? "?"})`);
  lines.push(`Calls inspected: ${report.totals.total_calls}`);
  lines.push(`Total prompt tokens: ${n(report.totals.total_prompt_tokens)}`);
  lines.push(`Total response tokens: ${n(report.totals.total_response_tokens)}`);
  lines.push("");
  lines.push("Context breakdown:");
  lines.push(`- System/developer: ${n(report.totals.categories.system)} tokens`);
  lines.push(`- Tools/skills: ${n(report.totals.categories.tools)} tokens`);
  lines.push(`- Memory/profile: ${n(report.totals.categories.memory)} tokens`);
  lines.push(`- Conversation history: ${n(report.totals.categories.history)} tokens`);
  lines.push(`- Tool output/logs: ${n(report.totals.categories.toolOutput)} tokens`);
  lines.push(`- Unknown: ${n(report.totals.categories.unknown)} tokens`);
  lines.push("");

  if (report.topFlags.length === 0) {
    lines.push("Top context bloat flags: none fired.");
  } else {
    lines.push("Top context bloat flags:");
    report.topFlags.slice(0, 5).forEach((f, i) => {
      lines.push(`${i + 1}. ${f.flag_type} [${f.top_severity}]`);
      lines.push(`   ${f.top_message}`);
      if (f.top_suggestion) lines.push(`   Suggestion: ${f.top_suggestion}`);
    });
  }
  lines.push("");

  if (report.largestCall) {
    lines.push("Largest single call:");
    lines.push(`- Call ID: ${report.largestCall.call_id}`);
    lines.push(`- Prompt tokens: ${n(report.largestCall.prompt_tokens)}`);
    lines.push(
      `- Biggest category: ${report.largestCall.biggest_category} (${n(report.largestCall.biggest_category_tokens)} tokens)`,
    );
    lines.push("");
  }

  lines.push(report.summary);
  return lines.join("\n");
}
