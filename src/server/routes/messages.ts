import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../../core/config/schema.js";
import { CircuitBreaker } from "../../core/proxy/circuitBreaker.js";
import { extractGuvnahHeaders } from "../../core/proxy/normalizeRequest.js";
import { forwardChatCompletion, forwardChatCompletionStream } from "../../core/proxy/providerClient.js";
import {
  extractAnthropicUsage,
  extractAnthropicStreamingUsage,
} from "../../core/proxy/anthropicUsage.js";
import {
  bumpRunTotals,
  ensureRun,
  insertCall,
  updateCallResult,
} from "../../db/queries.js";
import { logger } from "../../core/logging/logger.js";
import { emitCostLine } from "../../core/notify/cliNotifier.js";
import { estimateCostUsdWithCache, resolvePricing } from "../../core/pricing/resolvePricing.js";

interface RouteDeps {
  config: GuvnahConfig;
  db: Database.Database | null;
  breaker: CircuitBreaker;
}

interface AnthropicRequestBody {
  model?: string;
  stream?: boolean;
}

function parseBodyJson(buf: Buffer): AnthropicRequestBody | null {
  try {
    return JSON.parse(buf.toString("utf8")) as AnthropicRequestBody;
  } catch {
    return null;
  }
}

function copyResponseHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      lower === "content-length" ||
      lower === "transfer-encoding" ||
      lower === "connection"
    ) continue;
    reply.header(k, v);
  }
}

function computeAnthropicCost(
  model: string | null,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  config: GuvnahConfig,
): number | null {
  if (!model) return null;
  const { pricing } = resolvePricing(model, config);
  if (!pricing) return null;
  return estimateCostUsdWithCache({
    pricing,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
  });
}

export function registerMessagesRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/v1/messages", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = req.body as Buffer;
    const parsed = parseBodyJson(rawBody);
    const isStreaming = parsed?.stream === true;
    const headers = extractGuvnahHeaders(req.headers);
    const callId = `call-${nanoid(10)}`;
    const createdAt = new Date().toISOString();

    // Anthropic-native: skip the OpenAI-shape inspector entirely. Insert a
    // minimal call row so usage and cost can land on UPDATE.
    await deps.breaker.run<void>(
      "db-pre",
      () => {
        if (!deps.db) return;
        ensureRun(deps.db, {
          run_id: headers.run_id,
          agent_id: headers.agent_id,
          task_id: headers.task_id,
          task_type: headers.task_type,
          started_at: createdAt,
        });
        insertCall(deps.db, {
          id: callId,
          run_id: headers.run_id,
          agent_id: headers.agent_id,
          task_id: headers.task_id,
          task_type: headers.task_type,
          upstream_model: parsed?.model ?? null,
          upstream: null,
          dialect: "anthropic",
          prompt_tokens: 0,
          response_tokens: 0,
          total_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          cost_usd: null,
          system_tokens: 0,
          tool_tokens: 0,
          memory_tokens: 0,
          history_tokens: 0,
          tool_output_tokens: 0,
          unknown_tokens: 0,
          request_hash: null,
          stable_prefix_hash: null,
          latency_ms: null,
          status: "pending",
          error_message: null,
          created_at: createdAt,
        });
      },
      undefined,
    );

    const recordPost = async (args: {
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      latencyMs: number;
      status: number;
      errorMessage: string | null;
      upstreamName?: string | null;
      costUsd?: number | null;
    }) => {
      await deps.breaker.run<void>(
        "db-post",
        () => {
          if (!deps.db) return;
          updateCallResult(deps.db, {
            id: callId,
            response_tokens: args.outputTokens,
            total_tokens: args.inputTokens + args.outputTokens,
            cache_creation_tokens: args.cacheCreationTokens,
            cache_read_tokens: args.cacheReadTokens,
            cost_usd: args.costUsd ?? null,
            upstream: args.upstreamName ?? null,
            latency_ms: args.latencyMs,
            status: args.status >= 200 && args.status < 300 ? "ok" : "upstream_error",
            error_message: args.errorMessage,
          });
          // Update prompt_tokens and run totals (insertCall set them to 0).
          deps.db
            .prepare(`UPDATE llm_calls SET prompt_tokens = ? WHERE id = ?`)
            .run(args.inputTokens, callId);
          bumpRunTotals(deps.db, {
            run_id: headers.run_id,
            prompt_tokens: args.inputTokens,
            response_tokens: args.outputTokens,
            flags_added: 0,
          });
        },
        undefined,
      );
    };

    const emitCostLineSafe = (inputTokens: number, outputTokens: number) => {
      try {
        emitCostLine(
          {
            model: parsed?.model ?? null,
            promptTokens: inputTokens,
            responseTokens: outputTokens,
            runId: headers.run_id,
          },
          deps.config,
        );
      } catch (err) {
        logger.warn("guvnah.notify.failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    if (isStreaming) {
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
        await recordPost({
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          latencyMs: 0,
          status: 502,
          errorMessage: msg,
        });
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
        await recordPost({
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          latencyMs: Date.now() - upstream.startedAt,
          status: 502,
          errorMessage: msg,
          upstreamName: upstream.upstream_name,
        });
        return;
      }

      const usage = extractAnthropicStreamingUsage(Buffer.concat(accumulated));
      const costUsd = computeAnthropicCost(
        parsed?.model ?? null,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationTokens,
        usage.cacheReadTokens,
        deps.config,
      );
      await recordPost({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        latencyMs: Date.now() - upstream.startedAt,
        status: upstream.status,
        errorMessage: null,
        upstreamName: upstream.upstream_name,
        costUsd,
      });
      emitCostLineSafe(usage.inputTokens, usage.outputTokens);
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
      await recordPost({
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        latencyMs: 0,
        status: 502,
        errorMessage: msg,
      });
      reply.code(502);
      return {
        error: {
          message: `Upstream request failed: ${msg}`,
          type: "upstream_error",
          code: "upstream_unreachable",
        },
      };
    }

    const usage = extractAnthropicUsage(upstream.body);
    const costUsd = computeAnthropicCost(
      parsed?.model ?? null,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheCreationTokens,
      usage.cacheReadTokens,
      deps.config,
    );
    await recordPost({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      latencyMs: upstream.latencyMs,
      status: upstream.status,
      errorMessage: null,
      upstreamName: upstream.upstream_name,
      costUsd,
    });
    emitCostLineSafe(usage.inputTokens, usage.outputTokens);

    copyResponseHeaders(reply, upstream.headers);
    reply.code(upstream.status);
    return reply.send(upstream.body);
  });
}
