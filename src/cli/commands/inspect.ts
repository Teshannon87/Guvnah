import { readFileSync } from "node:fs";
import { loadConfig } from "../../core/config/loadConfig.js";
import { inspectPrompt } from "../../core/inspect/inspectPrompt.js";
import type { ChatRequest } from "../../types/index.js";

export interface InspectOptions {
  json?: boolean;
  config?: string;
}

function formatStandaloneInspection(
  inspection: ReturnType<typeof inspectPrompt>,
): string {
  const lines: string[] = [];
  lines.push(`Prompt tokens (estimate): ${inspection.promptTokens.toLocaleString()}`);
  lines.push("");
  lines.push("Context breakdown:");
  lines.push(`- System/developer: ${inspection.categories.system.toLocaleString()} tokens`);
  lines.push(`- Tools/skills: ${inspection.categories.tools.toLocaleString()} tokens`);
  lines.push(`- Memory/profile: ${inspection.categories.memory.toLocaleString()} tokens`);
  lines.push(`- Conversation history: ${inspection.categories.history.toLocaleString()} tokens`);
  lines.push(`- Tool output/logs: ${inspection.categories.toolOutput.toLocaleString()} tokens`);
  lines.push(`- Unknown: ${inspection.categories.unknown.toLocaleString()} tokens`);
  lines.push("");
  if (inspection.flags.length === 0) {
    lines.push("No flags fired.");
  } else {
    lines.push(`Flags (${inspection.flags.length}):`);
    inspection.flags.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.flag_type} [${f.severity}] — ${f.message}`);
      lines.push(`   Suggestion: ${f.suggestion}`);
    });
  }
  if (inspection.repeatedBlocks.length > 0) {
    lines.push("");
    lines.push(`Repeated blocks (${inspection.repeatedBlocks.length}):`);
    for (const b of inspection.repeatedBlocks.slice(0, 5)) {
      lines.push(
        `- hash=${b.block_hash} occ=${b.occurrences} ~${b.estimated_tokens.toLocaleString()} tokens`,
      );
      lines.push(`    "${b.sample_preview.replace(/\s+/g, " ").slice(0, 120)}…"`);
    }
  }
  lines.push("");
  lines.push(`Request hash: ${inspection.requestHash}`);
  if (inspection.stablePrefixHash) {
    lines.push(`Stable prefix hash: ${inspection.stablePrefixHash}`);
  }
  return lines.join("\n");
}

export function runInspect(file: string, opts: InspectOptions = {}): void {
  const { config } = loadConfig(opts.config);
  const raw = readFileSync(file, "utf8");
  let parsed: ChatRequest;
  try {
    parsed = JSON.parse(raw) as ChatRequest;
  } catch (err) {
    console.error(`Could not parse ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const inspection = inspectPrompt(parsed, { config });
  if (opts.json) {
    console.log(JSON.stringify(inspection, null, 2));
  } else {
    console.log(formatStandaloneInspection(inspection));
  }
}
