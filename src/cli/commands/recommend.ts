import { loadConfig } from "../../core/config/loadConfig.js";
import { openDatabase } from "../../db/client.js";
import { buildRecommendations } from "../../core/reports/buildRecommendations.js";
import { formatRecommendations } from "../../core/reports/formatRecommendations.js";

export interface RecommendOptions {
  agent?: string;
  since?: string;
  json?: boolean;
  config?: string;
  minShipped?: number;
}

export function runRecommend(opts: RecommendOptions = {}): void {
  const { config } = loadConfig(opts.config);
  const handle = openDatabase(config.database.path);
  if (handle.error || !handle.db) {
    console.error(
      `Unable to open SQLite at ${config.database.path}: ${
        handle.error?.message ?? "unknown error"
      }`,
    );
    process.exitCode = 1;
    return;
  }
  const db = handle.db;
  try {
    const sinceIso = parseSince(opts.since);
    const recs = buildRecommendations(db, {
      agentId: opts.agent,
      sinceIso,
      minShippedCalls: opts.minShipped,
    });
    if (opts.json) {
      console.log(JSON.stringify(recs, null, 2));
    } else {
      console.log(formatRecommendations(recs));
    }
  } finally {
    db.close();
  }
}

function parseSince(since: string | undefined): string {
  if (!since) {
    return new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  }
  const m = /^(\d+)([mhd])$/.exec(since);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!;
    const ms =
      unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  const t = Date.parse(since);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return new Date(Date.now() - 24 * 60 * 60_000).toISOString();
}
