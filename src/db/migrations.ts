import type Database from "better-sqlite3";
import { SCHEMA_STATEMENTS } from "./schema.js";

export function applyMigrations(db: Database.Database): void {
  for (const stmt of SCHEMA_STATEMENTS) {
    db.exec(stmt);
  }
}
