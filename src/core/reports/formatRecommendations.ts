import type { Recommendation } from "./buildRecommendations.js";

export function formatRecommendations(recs: Recommendation[]): string {
  if (recs.length === 0) {
    return "No recommendations. Nothing actionable surfaced from the last window.";
  }
  const lines: string[] = [];
  lines.push(`Guvnah recommendations (${recs.length})`);
  lines.push("=".repeat(60));

  for (const r of recs) {
    lines.push("");
    lines.push(`[${r.severity.toUpperCase()}] ${r.title}`);
    lines.push(`  id: ${r.id}`);
    lines.push(`  reason: ${r.reason}`);
    lines.push(`  action: ${r.suggested_action}`);
    lines.push(`  revert: ${r.revert_hint}`);
    const desc = r.evidence.description_preview;
    if (typeof desc === "string" && desc.length > 0) {
      lines.push(`  description: "${desc}"`);
    }
    const evidence = { ...r.evidence };
    delete evidence.description_preview;
    if (Object.keys(evidence).length > 0) {
      const ev = Object.entries(evidence)
        .map(([k, v]) => `${k}=${formatVal(v)}`)
        .join(", ");
      lines.push(`  evidence: ${ev}`);
    }
  }
  lines.push("");
  lines.push(
    "Recommendations only. No changes have been applied to your agent's config.",
  );
  return lines.join("\n");
}

function formatVal(v: unknown): string {
  if (typeof v === "number") return v.toLocaleString();
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}
