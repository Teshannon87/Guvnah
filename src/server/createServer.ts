import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../core/config/schema.js";
import { CircuitBreaker } from "../core/proxy/circuitBreaker.js";
import { registerChatCompletionsRoute } from "./routes/chatCompletions.js";
import { registerMessagesRoute } from "./routes/messages.js";
import { registerHealthRoute } from "./routes/health.js";
import { logger } from "../core/logging/logger.js";
import {
  createInlinePool,
  createPiscinaPool,
  type AnalysisPool,
} from "../core/analysis/pool.js";
import analyzeInline from "../core/analysis/worker.js";

export interface ServerDeps {
  config: GuvnahConfig;
  db: Database.Database | null;
  version: string;
  // Optional injection point for tests: an in-process pool that runs the
  // analyzer synchronously. When omitted in production, a Piscina pool is
  // created pointing at the built worker file.
  pool?: AnalysisPool;
  dbPath?: string | null;
}

function defaultPool(): AnalysisPool {
  try {
    const workerUrl = new URL("../core/analysis/worker.js", import.meta.url);
    return createPiscinaPool(workerUrl.pathname);
  } catch (err) {
    logger.warn("guvnah.pool.fallback_inline", {
      error: err instanceof Error ? err.message : String(err),
      message: "Piscina pool unavailable, falling back to inline analysis",
    });
    return createInlinePool(analyzeInline);
  }
}

export async function createServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 50 * 1024 * 1024,
  });

  // Raw body capture for /v1/chat/completions so we can forward bytes verbatim.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  const breaker = new CircuitBreaker(deps.config.breaker);
  const pool = deps.pool ?? defaultPool();
  const dbPath = deps.dbPath ?? deps.config.database.path;

  registerHealthRoute(app, deps.version);
  registerChatCompletionsRoute(app, {
    config: deps.config,
    db: deps.db,
    breaker,
    pool,
    dbPath,
  });
  registerMessagesRoute(app, {
    config: deps.config,
    db: deps.db,
    breaker,
    pool,
    dbPath,
  });

  // Close the pool when Fastify shuts down so worker threads exit cleanly.
  app.addHook("onClose", async () => {
    try {
      await pool.close();
    } catch {
      // ignore — best-effort shutdown
    }
  });

  if (deps.config.server.host === "0.0.0.0") {
    logger.warn("guvnah.security.bind_all_interfaces", {
      message:
        "Server is bound to 0.0.0.0; anyone on this network can reach Guvnah. Prefer 127.0.0.1 for local-only use.",
    });
  }
  if (!deps.db) {
    logger.warn("guvnah.db.unavailable", {
      message:
        "SQLite database is unavailable; Guvnah will continue to forward requests but will not log inspection data.",
    });
  }

  return app;
}
