import { loadConfig } from "../../core/config/loadConfig.js";
import { openDatabase } from "../../db/client.js";
import { buildRunReport } from "../../core/reports/buildRunReport.js";
import { formatRunReport } from "../../core/reports/formatRunReport.js";
import { formatSummaryReport } from "../../core/reports/formatSummaryReport.js";
import { getRecentRuns } from "../../db/queries.js";

export interface ReportOptions {
  run?: string;
  today?: boolean;
  json?: boolean;
  agent?: string;
  config?: string;
}

export function runReport(opts: ReportOptions = {}): void {
  const { config } = loadConfig(opts.config);
  const handle = openDatabase(config.database.path);
  if (handle.error || !handle.db) {
    console.error(`Unable to open SQLite at ${config.database.path}: ${handle.error?.message ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  const db = handle.db;

  try {
    if (opts.run) {
      const report = buildRunReport(db, opts.run);
      if (!report) {
        console.error(`No run found with id "${opts.run}"`);
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatRunReport(report));
      }
      return;
    }

    const since = opts.today
      ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
      : undefined;
    const runs = getRecentRuns(db, {
      sinceIso: since,
      agentId: opts.agent,
      limit: 50,
    });
    if (opts.json) {
      console.log(JSON.stringify(runs, null, 2));
    } else {
      console.log(formatSummaryReport(runs));
    }
  } finally {
    db.close();
  }
}
