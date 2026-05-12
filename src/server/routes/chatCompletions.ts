import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../../core/config/schema.js";
import { CircuitBreaker } from "../../core/proxy/circuitBreaker.js";
import { extractGuvnahHeaders } from "../../core/proxy/normalizeRequest.js";
import { forwardChatCompletion } from "../../core/proxy/providerClient.js";
import { inspectPrompt } from "../../core/inspect/inspectPrompt.js";
import {
  bumpRunTotals,
  ensureRun,
  getLastStablePrefixHash,
  getPriorBlockOccurrences,
  insertCall,
  insertFlag,
  insertRepeatedBlock,
  updateCallResult,
} from "../../db/queries.js";
import { logger } from "../../core/logging/logger.js";
import type { ChatRequest, PromptInspection } from "../../types/index.js";

interface RouteDeps {
  config: GuvnahConfig;
  db: Database.Database | null;
  breaker: CircuitBreaker;
}

function parseBodyJson(buf: Buffer): ChatRequest | null {
  try {
    return JSON.parse(buf.toString("utf8")) as ChatRequest;
  } catch {
    return null;
  }
}

function extractResponseTokens(body: Buffer): number {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      usage?: { completion_tokens?: number; output_tokens?: number };
    };
    return (
      parsed.usage?.completion_tokens ??
      parsed.usage?.output_tokens ??
      0
    );
  } catch {
    return 0;
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

export function registerChatCompletionsRoute(app: FastifyInstance, deps: RouteDeps): void {
  app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
    const rawBody = req.body as Buffer;
    const parsed = parseBodyJson(rawBody);

    if (parsed?.stream === true) {
      reply.code(400);
      return {
        error: {
          message:
            "Guvnah Context Inspector v1 does not support streaming. Set stream: false or point your agent directly at the upstream.",
          type: "guvnah_unsupported",
          code: "stream_not_supported",
        },
      };
    }

    const headers = extractGuvnahHeaders(req.headers);
    const callId = `call-${nanoid(10)}`;
    const createdAt = new Date().toISOString();

    let inspection: PromptInspection | null = null;
    if (parsed) {
      inspection = await deps.breaker.run<PromptInspection | null>(
        "inspect",
        () => {
          const previousStablePrefixHash = deps.db
            ? getLastStablePrefixHash(deps.db, headers.run_id)
            : null;
          const priorBlockOccurrences = deps.db
            ? (h: string) => getPriorBlockOccurrences(deps.db!, headers.run_id, h)
            : () => 0;
          return inspectPrompt(parsed, {
            config: deps.config,
            previousStablePrefixHash,
            priorBlockOccurrences,
          });
        },
        null,
      );
    }

    await deps.breaker.run<void>(
      "db-pre",
      () => {
        if (!deps.db || !inspection) return;
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
          prompt_tokens: inspection.promptTokens,
          response_tokens: 0,
          total_tokens: 0,
          system_tokens: inspection.categories.system,
          tool_tokens: inspection.categories.tools,
          memory_tokens: inspection.categories.memory,
          history_tokens: inspection.categories.history,
          tool_output_tokens: inspection.categories.toolOutput,
          unknown_tokens: inspection.categories.unknown,
          request_hash: inspection.requestHash,
          stable_prefix_hash: inspection.stablePrefixHash ?? null,
          latency_ms: null,
          status: "pending",
          error_message: null,
          created_at: createdAt,
        });
      },
      undefined,
    );

    // CRITICAL: forwarding is never wrapped by the breaker.
    let upstream;
    try {
      upstream = await forwardChatCompletion({
        bodyBytes: rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
        config: deps.config,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("guvnah.upstream.error", { error: msg });
      await deps.breaker.run<void>(
        "db-post-error",
        () => {
          if (!deps.db || !inspection) return;
          updateCallResult(deps.db, {
            id: callId,
            response_tokens: 0,
            total_tokens: inspection.promptTokens,
            latency_ms: 0,
            status: "upstream_error",
            error_message: msg,
          });
        },
        undefined,
      );
      reply.code(502);
      return {
        error: {
          message: `Upstream request failed: ${msg}`,
          type: "upstream_error",
          code: "upstream_unreachable",
        },
      };
    }

    const responseTokens = extractResponseTokens(upstream.body);

    await deps.breaker.run<void>(
      "db-post",
      () => {
        if (!deps.db || !inspection) return;
        updateCallResult(deps.db, {
          id: callId,
          response_tokens: responseTokens,
          total_tokens: inspection.promptTokens + responseTokens,
          latency_ms: upstream.latencyMs,
          status: upstream.status >= 200 && upstream.status < 300 ? "ok" : "upstream_error",
          error_message: null,
        });
        for (const flag of inspection.flags) {
          insertFlag(deps.db, {
            id: `flag-${nanoid(10)}`,
            run_id: headers.run_id,
            llm_call_id: callId,
            flag: flag,
            created_at: new Date().toISOString(),
          });
        }
        for (const block of inspection.repeatedBlocks) {
          insertRepeatedBlock(deps.db, {
            id: `rb-${nanoid(10)}`,
            run_id: headers.run_id,
            llm_call_id: callId,
            block,
            created_at: new Date().toISOString(),
          });
        }
        bumpRunTotals(deps.db, {
          run_id: headers.run_id,
          prompt_tokens: inspection.promptTokens,
          response_tokens: responseTokens,
          flags_added: inspection.flags.length,
        });
      },
      undefined,
    );

    copyResponseHeaders(reply, upstream.headers);
    reply.code(upstream.status);
    return reply.send(upstream.body);
  });
}
