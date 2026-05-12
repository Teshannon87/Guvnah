import type Database from "better-sqlite3";
import { SCHEMA_STATEMENTS } from "./schema.js";

/**
 * Idempotent column adds for tables that already exist in older DBs.
 * SQLite has no ADD COLUMN IF NOT EXISTS; we swallow the duplicate-column error.
 */
const POST_MIGRATIONS: Array<{ description: string; sql: string }> = [
  {
    description: "tool_usage.description_preview",
    sql: `ALTER TABLE tool_usage ADD COLUMN description_preview TEXT`,
  },
];

export function applyMigrations(db: Database.Database): void {
  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
  for (const m of POST_MIGRATIONS) {
    try {
      db.exec(m.sql);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column name")) continue;
      throw err;
    }
  }
}
