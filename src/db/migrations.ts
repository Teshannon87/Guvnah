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
  {
    description: "llm_calls.upstream",
    sql: `ALTER TABLE llm_calls ADD COLUMN upstream TEXT`,
  },
  {
    description: "llm_calls.dialect",
    sql: `ALTER TABLE llm_calls ADD COLUMN dialect TEXT`,
  },
  {
    description: "llm_calls.cost_usd",
    sql: `ALTER TABLE llm_calls ADD COLUMN cost_usd REAL`,
  },
  {
    description: "llm_calls.cache_creation_tokens",
    sql: `ALTER TABLE llm_calls ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0`,
  },
  {
    description: "llm_calls.cache_read_tokens",
    sql: `ALTER TABLE llm_calls ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`,
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
