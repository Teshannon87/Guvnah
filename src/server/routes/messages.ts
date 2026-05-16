// /v1/messages — pure pass-through for Anthropic's native API. Same off-path
// analysis pattern as /v1/chat/completions. No pre-flight DB writes; the worker
// pool persists the row after the client has already received bytes.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../../core/config/schema.js";
import { CircuitBreaker } from "../../core/proxy/circuitBreaker.js";
import { extractGuvnahHeaders } from "../../core/proxy/normalizeRequest.js";
import { forwardChatCompletion, forwardChatCompletionStream } from "../../core/proxy/providerClient.js";
import { logger } from "../../core/logging/logger.js";
import { emitCostLine } from "../../core/notify/cliNotifier.js";
import type { AnalysisPool } from "../../core/analysis/pool.js";

interface RouteDeps {
  config: GuvnahConfig;
  db: Database.Database | null;
  breaker: CircuitBreaker;
  pool: AnalysisPool;
  dbPath: string | null;
}

function parseModel(buf: Buffer): { model: string | null; streaming: boolean } {
  try {
    const obj = JSON.parse(buf.toString("utf8")) as { model?: string; stream?: boolean };
    return { model: typeof obj.model === "string" ? obj.model : null, streaming: obj.stream === true };
  } catch {
    return { model: null, streaming: false };
  }
}

function copyResponseHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "content-length" || lower === "transfer-encoding" || lower === "connection") continue;
    reply.header(k, v);
  }
}

export function registerMessagesRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/v1/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = req.body as Buffer;
    const { model, streaming } = parseModel(rawBody);
    const guvnahHeaders = extractGuvnahHeaders(req.headers);
    const callId = `call-${nanoid(10)}`;
    const createdAt = new Date().toISOString();

    const submit = (
      responseBody: Buffer,
      status: number,
      latencyMs: number,
      upstreamName: string,
    ) => {
      deps.pool
        .submit({
          callId,
          createdAt,
          dialect: "anthropic",
          requestBody: rawBody,
          responseBody,
          streaming,
          status,
          latencyMs,
          upstreamName,
          clientModel: model,
          guvnahHeaders,
          config: deps.config,
          dbPath: deps.dbPath,
        })
        .then(
          (r) => {
            if (r.error) {
              logger.warn("guvnah.analysis.error", { error: r.error, call_id: callId });
              return;
            }
            try {
              emitCostLine(
                {
                  model: r.model,
                  promptTokens: r.promptTokens,
                  responseTokens: r.responseTokens,
                  runId: r.runId,
                },
                deps.config,
              );
            } catch (err) {
              logger.warn("guvnah.notify.failed", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          },
          (err) => {
            logger.warn("guvnah.analysis.error", {
              error: err instanceof Error ? err.message : String(err),
              call_id: callId,
            });
          },
        );
    };

    if (streaming) {
      let upstream;
      try {
        upstream = await forwardChatCompletionStream({
          bodyBytes: rawBody,
          headers: req.headers as Record<string, string | string[] | undefined>,
          config: deps.config,
          route: "messages",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("guvnah.upstream.error", { error: msg, streaming: true, route: "messages" });
        submit(Buffer.alloc(0), 502, 0, "unknown");
        reply.code(502);
        return {
          error: {
            message: `Upstream request failed: ${msg}`,
            type: "upstream_error",
            code: "upstream_unreachable",
          },
        };
      }

      copyResponseHeaders(reply, upstream.headers);
      reply.code(upstream.status);
      reply.hijack();
      const raw = reply.raw;
      for (const [k, v] of Object.entries(upstream.headers)) {
        const lower = k.toLowerCase();
        if (lower === "content-length" || lower === "transfer-encoding" || lower === "connection") continue;
        try { raw.setHeader(k, v); } catch { /* ignore */ }
      }
      raw.statusCode = upstream.status;

      const accumulated: Buffer[] = [];
      try {
        for await (const chunk of upstream.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          accumulated.push(buf);
          raw.write(buf);
        }
        raw.end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("guvnah.stream.error", { error: msg, route: "messages" });
        try { raw.end(); } catch { /* ignore */ }
        submit(Buffer.concat(accumulated), 502, Date.now() - upstream.startedAt, upstream.upstream_name);
        return;
      }

      submit(
        Buffer.concat(accumulated),
        upstream.status,
        Date.now() - upstream.startedAt,
        upstream.upstream_name,
      );
      return;
    }

    // Non-streaming path
    let upstream;
    try {
      upstream = await forwardChatCompletion({
        bodyBytes: rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
        config: deps.config,
        route: "messages",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("guvnah.upstream.error", { error: msg, route: "messages" });
      submit(Buffer.alloc(0), 502, 0, "unknown");
      reply.code(502);
      return {
        error: {
          message: `Upstream request failed: ${msg}`,
          type: "upstream_error",
          code: "upstream_unreachable",
        },
      };
    }

    submit(upstream.body, upstream.status, upstream.latencyMs, upstream.upstream_name);
    copyResponseHeaders(reply, upstream.headers);
    reply.code(upstream.status);
    return reply.send(upstream.body);
  });
}
