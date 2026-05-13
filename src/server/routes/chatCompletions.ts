import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../../core/config/schema.js";
import { CircuitBreaker } from "../../core/proxy/circuitBreaker.js";
import { extractGuvnahHeaders } from "../../core/proxy/normalizeRequest.js";
import { forwardChatCompletion, forwardChatCompletionStream } from "../../core/proxy/providerClient.js";
import { inspectPrompt } from "../../core/inspect/inspectPrompt.js";
import {
  bumpRunTotals,
  ensureRun,
  getLastStablePrefixHash,
  getPriorBlockOccurrences,
  getRecentPrefixHashesForAgent,
  insertCall,
  insertFlag,
  insertRepeatedBlock,
  insertToolUsage,
  updateCallResult,
} from "../../db/queries.js";
import { logger } from "../../core/logging/logger.js";
import { emitCostLine } from "../../core/notify/cliNotifier.js";
import { countTokens } from "../../core/tokens/countTokens.js";
import { estimateCostUsd, resolvePricing } from "../../core/pricing/resolvePricing.js";
import type { ChatRequest, PromptInspection } from "../../types/index.js";

interface RouteDeps {
  config: GuvnahConfig;
  db: Database.Database | null;
  breaker: CircuitBreaker;
}

interface UsageNumbers {
  promptTokens: number;
  responseTokens: number;
}

function parseBodyJson(buf: Buffer): ChatRequest | null {
  try {
    return JSON.parse(buf.toString("utf8")) as ChatRequest;
  } catch {
    return null;
  }
}

function extractUsage(body: Buffer): UsageNumbers {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      usage?: {
        prompt_tokens?: number;
        input_tokens?: number;
        completion_tokens?: number;
        output_tokens?: number;
      };
    };
    return {
      promptTokens: parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0,
      responseTokens:
        parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0,
    };
  } catch {
    return { promptTokens: 0, responseTokens: 0 };
  }
}

function extractStreamingUsage(buffered: Buffer): UsageNumbers {
  // SSE format: data: {...}\n\n entries. Two paths:
  //   1. If a chunk carries `usage` (provider opted in), use it as-is.
  //   2. Otherwise (e.g. Google's OpenAI-compat endpoint by default) reconstruct
  //      response tokens by tokenizing the assembled assistant content from all
  //      delta chunks. promptTokens stays 0 and the caller falls back to
  //      inspection.promptTokens. No request mutation involved.
  let assistantText = "";
  let foundUsage: UsageNumbers | null = null;
  try {
    const text = buffered.toString("utf8");
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload) as {
          usage?: {
            prompt_tokens?: number;
            input_tokens?: number;
            completion_tokens?: number;
            output_tokens?: number;
          };
          choices?: Array<{
            delta?: {
              content?: string | Array<{ text?: string }>;
            };
          }>;
        };
        if (obj.usage && !foundUsage) {
          foundUsage = {
            promptTokens: obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? 0,
            responseTokens:
              obj.usage.completion_tokens ?? obj.usage.output_tokens ?? 0,
          };
        }
        const delta = obj.choices?.[0]?.delta?.content;
        if (typeof delta === "string") {
          assistantText += delta;
        } else if (Array.isArray(delta)) {
          for (const part of delta) {
            if (part && typeof part.text === "string") assistantText += part.text;
          }
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  if (foundUsage) return foundUsage;
  if (assistantText.length > 0) {
    return { promptTokens: 0, responseTokens: countTokens(assistantText) };
  }
  return { promptTokens: 0, responseTokens: 0 };
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
    const isStreaming = parsed?.stream === true;

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
          const windowMin = deps.config.detection.cache_thrash_window_minutes;
          const sinceIso = new Date(Date.now() - windowMin * 60_000).toISOString();
          const recentDistinctPrefixHashes = deps.db
            ? getRecentPrefixHashesForAgent(deps.db, {
                agent_id: headers.agent_id,
                sinceIso,
              })
            : [];
          return inspectPrompt(parsed, {
            config: deps.config,
            previousStablePrefixHash,
            priorBlockOccurrences,
            recentDistinctPrefixHashes,
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
          upstream: null,
          dialect: "openai",
          prompt_tokens: inspection.promptTokens,
          response_tokens: 0,
          total_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          cost_usd: null,
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

    const recordPost = async (args: {
      responseTokens: number;
      latencyMs: number;
      status: number;
      errorMessage: string | null;
      upstreamName?: string | null;
      costUsd?: number | null;
    }) => {
      const { responseTokens, latencyMs, status, errorMessage, upstreamName, costUsd } = args;
      await deps.breaker.run<void>(
        "db-post",
        () => {
          if (!deps.db || !inspection) return;
          updateCallResult(deps.db, {
            id: callId,
            response_tokens: responseTokens,
            total_tokens: inspection.promptTokens + responseTokens,
            cost_usd: costUsd ?? null,
            upstream: upstreamName ?? null,
            latency_ms: latencyMs,
            status: status >= 200 && status < 300 ? "ok" : "upstream_error",
            error_message: errorMessage,
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
          for (const entry of inspection.toolUsage) {
            insertToolUsage(deps.db, {
              id: `tu-${nanoid(10)}`,
              call_id: callId,
              run_id: headers.run_id,
              agent_id: headers.agent_id,
              entry,
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
    };

    const emitCostLineSafe = (usage: UsageNumbers) => {
      try {
        emitCostLine(
          {
            model: parsed?.model ?? null,
            promptTokens: inspection?.promptTokens ?? usage.promptTokens,
            responseTokens: usage.responseTokens,
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
      // Streaming path: pipe SSE chunks through while accumulating for usage.
      let upstream;
      try {
        upstream = await forwardChatCompletionStream({
          bodyBytes: rawBody,
          headers: req.headers as Record<string, string | string[] | undefined>,
          config: deps.config,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("guvnah.upstream.error", { error: msg, streaming: true });
        await recordPost({ responseTokens: 0, latencyMs: 0, status: 502, errorMessage: msg });
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
      // Re-write headers Fastify didn't push because of hijack
      for (const [k, v] of Object.entries(upstream.headers)) {
        const lower = k.toLowerCase();
        if (
          lower === "content-length" ||
          lower === "transfer-encoding" ||
          lower === "connection"
        ) continue;
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
        logger.error("guvnah.stream.error", { error: msg });
        try { raw.end(); } catch { /* ignore */ }
        await recordPost({
          responseTokens: 0,
          latencyMs: Date.now() - upstream.startedAt,
          status: 502,
          errorMessage: msg,
          upstreamName: upstream.upstream_name,
        });
        return;
      }

      const usage = extractStreamingUsage(Buffer.concat(accumulated));
      const costUsd = computeOpenAICost(parsed?.model ?? null, inspection?.promptTokens ?? usage.promptTokens, usage.responseTokens, deps.config);
      await recordPost({
        responseTokens: usage.responseTokens,
        latencyMs: Date.now() - upstream.startedAt,
        status: upstream.status,
        errorMessage: null,
        upstreamName: upstream.upstream_name,
        costUsd,
      });
      emitCostLineSafe(usage);
      return;
    }

    // Non-streaming path
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
      await recordPost({ responseTokens: 0, latencyMs: 0, status: 502, errorMessage: msg });
      reply.code(502);
      return {
        error: {
          message: `Upstream request failed: ${msg}`,
          type: "upstream_error",
          code: "upstream_unreachable",
        },
      };
    }

    const usage = extractUsage(upstream.body);
    const costUsd = computeOpenAICost(parsed?.model ?? null, inspection?.promptTokens ?? usage.promptTokens, usage.responseTokens, deps.config);
    await recordPost({
      responseTokens: usage.responseTokens,
      latencyMs: upstream.latencyMs,
      status: upstream.status,
      errorMessage: null,
      upstreamName: upstream.upstream_name,
      costUsd,
    });
    emitCostLineSafe(usage);

    copyResponseHeaders(reply, upstream.headers);
    reply.code(upstream.status);
    return reply.send(upstream.body);
  });
}

function computeOpenAICost(
  model: string | null,
  promptTokens: number,
  responseTokens: number,
  config: import("../../core/config/schema.js").GuvnahConfig,
): number | null {
  if (!model) return null;
  const { pricing } = resolvePricing(model, config);
  if (!pricing) return null;
  return estimateCostUsd(pricing, promptTokens, responseTokens);
}
