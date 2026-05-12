import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyMigrations } from "./migrations.js";

export interface DbHandle {
  db: Database.Database | null;
  path: string;
  error: Error | null;
}

export function openDatabase(dbPath: string): DbHandle {
  const absolute = resolve(dbPath);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    const db = new Database(absolute);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    applyMigrations(db);
    return { db, path: absolute, error: null };
  } catch (err) {
    return {
      db: null,
      path: absolute,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

export function closeDatabase(handle: DbHandle): void {
  if (handle.db) {
    try {
      handle.db.close();
    } catch {
      // ignore
    }
  }
}
