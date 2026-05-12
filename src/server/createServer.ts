import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../core/config/schema.js";
import { CircuitBreaker } from "../core/proxy/circuitBreaker.js";
import { registerChatCompletionsRoute } from "./routes/chatCompletions.js";
import { registerHealthRoute } from "./routes/health.js";
import { logger } from "../core/logging/logger.js";
import { RunTracker } from "../core/notify/runTracker.js";

export interface ServerDeps {
  config: GuvnahConfig;
  db: Database.Database | null;
  version: string;
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
  const runTracker = new RunTracker(deps.config);
  runTracker.start();
  app.addHook("onClose", async () => {
    runTracker.stop();
  });

  registerHealthRoute(app, deps.version);
  registerChatCompletionsRoute(app, {
    config: deps.config,
    db: deps.db,
    breaker,
    runTracker,
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
