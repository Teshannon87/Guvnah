import { loadConfig } from "../../core/config/loadConfig.js";
import { openDatabase } from "../../db/client.js";
import { createServer } from "../../server/createServer.js";
import { logger } from "../../core/logging/logger.js";

export interface ProxyOptions {
  config?: string;
  host?: string;
  port?: number;
}

export async function runProxy(opts: ProxyOptions = {}): Promise<void> {
  const { config, source } = loadConfig(opts.config);
  if (opts.host) config.server.host = opts.host;
  if (opts.port) config.server.port = opts.port;

  const handle = openDatabase(config.database.path);
  if (handle.error) {
    logger.warn("guvnah.startup.db_failed", {
      error: handle.error.message,
      message:
        "Starting in degraded mode: requests will be forwarded but inspection data will not be persisted.",
    });
  }

  const version = process.env.npm_package_version ?? "0.1.0";
  const app = await createServer({ config, db: handle.db, version });

  try {
    const address = await app.listen({
      host: config.server.host,
      port: config.server.port,
    });
    console.log(`Guvnah Context Inspector listening on ${address}`);
    console.log(`Upstream: ${config.upstream.base_url}`);
    console.log(`Mode: ${config.mode.inspect_only ? "inspect-only" : "MUTATE (use with caution)"}`);
    console.log(`Config: ${source ?? "defaults (no config file found)"}`);
    if (!handle.db) {
      console.log("WARNING: SQLite is unavailable; reports will be empty until the DB is fixed.");
    }
  } catch (err) {
    logger.error("guvnah.startup.listen_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    logger.info("guvnah.shutdown", { signal });
    try {
      await app.close();
    } catch {
      // ignore
    }
    if (handle.db) {
      try {
        handle.db.close();
      } catch {
        // ignore
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
