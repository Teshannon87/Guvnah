// Piscina worker: runs off the request hot path. Parses the upstream usage,
// runs prompt inspection (OpenAI dialect only), computes cost, and persists
// the call row + flags. Returns a small summary the main thread uses for the
// cost-line emit.

import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { CircuitBreaker } from "../proxy/circuitBreaker.js";
import { inspectPrompt } from "../inspect/inspectPrompt.js";
import { countTokens } from "../tokens/countTokens.js";
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
} from "../../db/queries.js";
import { estimateCostUsd, estimateCostUsdWithCache, resolvePricing } from "../pricing/resolvePricing.js";
import { extractAnthropicStreamingUsage, extractAnthropicUsage } from "../proxy/anthropicUsage.js";
import type { ChatRequest, PromptInspection } from "../../types/index.js";
import type { AnalysisResult, AnalysisTask } from "./types.js";

// One DB handle per (worker thread, path). WAL mode allows concurrent readers
// and serialized writers — fine for our load. Keyed by path so tests with
// multiple tmp DBs don't collide on a single cached handle.
const dbHandles = new Map<string, Database.Database>();
function openDb(path: string | null): Database.Database | null {
  if (!path) return null;
  const cached = dbHandles.get(path);
  if (cached) return cached;
  try {
    const h = new Database(path);
    h.pragma("journal_mode = WAL");
    h.pragma("synchronous = NORMAL");
    dbHandles.set(path, h);
    return h;
  } catch {
    return null;
  }
}

interface OpenAiUsage {
  promptTokens: number;
  responseTokens: number;
}

function parseChatRequest(body: Buffer): ChatRequest | null {
  try {
    return JSON.parse(body.toString("utf8")) as ChatRequest;
  } catch {
    return null;
  }
}

function extractOpenAiUsage(body: Buffer): OpenAiUsage {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      usage?: { prompt_tokens?: number; input_tokens?: number; completion_tokens?: number; output_tokens?: number };
    };
    return {
      promptTokens: parsed.usage?.prompt_tokens ?? parsed.usage?.input_tokens ?? 0,
      responseTokens: parsed.usage?.completion_tokens ?? parsed.usage?.output_tokens ?? 0,
    };
  } catch {
    return { promptTokens: 0, responseTokens: 0 };
  }
}

function extractOpenAiStreamingUsage(body: Buffer): OpenAiUsage {
  let assistantText = "";
  let foundUsage: OpenAiUsage | null = null;
  try {
    const lines = body.toString("utf8").split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload) as {
          usage?: { prompt_tokens?: number; input_tokens?: number; completion_tokens?: number; output_tokens?: number };
          choices?: Array<{ delta?: { content?: string | Array<{ text?: string }> } }>;
        };
        if (obj.usage && !foundUsage) {
          foundUsage = {
            promptTokens: obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? 0,
            responseTokens: obj.usage.completion_tokens ?? obj.usage.output_tokens ?? 0,
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
  if (assistantText.length > 0) return { promptTokens: 0, responseTokens: countTokens(assistantText) };
  return { promptTokens: 0, responseTokens: 0 };
}

export default async function analyze(task: AnalysisTask): Promise<AnalysisResult> {
  // Piscina serializes the task via structured clone, which turns Node Buffers
  // into plain Uint8Arrays — and Uint8Array.toString("utf8") returns the byte
  // array as decimal text, not the decoded string. Wrap once at the entry so
  // downstream code can treat them as Buffers uniformly. Buffer.from over a
  // Uint8Array is zero-copy (shares the underlying ArrayBuffer).
  const requestBody = Buffer.isBuffer(task.requestBody)
    ? task.requestBody
    : Buffer.from(task.requestBody);
  const responseBody = Buffer.isBuffer(task.responseBody)
    ? task.responseBody
    : Buffer.from(task.responseBody);
  const db = openDb(task.dbPath);
  const headers = task.guvnahHeaders;
  const httpOk = task.status >= 200 && task.status < 300;
  const rowStatus: "ok" | "upstream_error" = httpOk ? "ok" : "upstream_error";

  // Run pre-call DB lookups + inspection only for OpenAI dialect, since
  // inspectPrompt only understands OpenAI-shape messages.
  let inspection: PromptInspection | null = null;
  if (task.dialect === "openai") {
    const parsed = parseChatRequest(requestBody);
    if (parsed) {
      try {
        const previousStablePrefixHash = db ? getLastStablePrefixHash(db, headers.run_id) : null;
        const priorBlockOccurrences = db
          ? (h: string) => getPriorBlockOccurrences(db, headers.run_id, h)
          : () => 0;
        const sinceIso = new Date(
          Date.now() - task.config.detection.cache_thrash_window_minutes * 60_000,
        ).toISOString();
        const recentDistinctPrefixHashes = db
          ? getRecentPrefixHashesForAgent(db, { agent_id: headers.agent_id, sinceIso })
          : [];
        inspection = inspectPrompt(parsed, {
          config: task.config,
          previousStablePrefixHash,
          priorBlockOccurrences,
          recentDistinctPrefixHashes,
        });
      } catch (err) {
        return {
          model: task.clientModel,
          promptTokens: 0,
          responseTokens: 0,
          costUsd: null,
          runId: headers.run_id,
          status: rowStatus,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // Parse upstream usage (dialect-aware).
  let promptTokens = 0;
  let responseTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  if (task.dialect === "anthropic") {
    const u = task.streaming
      ? extractAnthropicStreamingUsage(responseBody)
      : extractAnthropicUsage(responseBody);
    promptTokens = u.inputTokens;
    responseTokens = u.outputTokens;
    cacheCreationTokens = u.cacheCreationTokens;
    cacheReadTokens = u.cacheReadTokens;
  } else {
    const u = task.streaming
      ? extractOpenAiStreamingUsage(responseBody)
      : extractOpenAiUsage(responseBody);
    // Prefer inspection's prompt count when upstream didn't return one (e.g.,
    // Gemini's OpenAI-compat endpoint omits it in streaming).
    promptTokens = u.promptTokens || inspection?.promptTokens || 0;
    responseTokens = u.responseTokens;
  }

  // Compute cost.
  const costUsd = (() => {
    if (!task.clientModel) return null;
    const { pricing } = resolvePricing(task.clientModel, task.config);
    if (!pricing) return null;
    if (task.dialect === "anthropic") {
      return estimateCostUsdWithCache({
        pricing,
        inputTokens: promptTokens,
        outputTokens: responseTokens,
        cacheCreationTokens,
        cacheReadTokens,
      });
    }
    return estimateCostUsd(pricing, promptTokens, responseTokens);
  })();

  // Persist. Use a private breaker so a flaky DB doesn't blow up the worker.
  if (db) {
    const breaker = new CircuitBreaker(task.config.breaker);
    try {
      await breaker.run<void>(
        "worker.persist",
        () => {
          ensureRun(db, {
            run_id: headers.run_id,
            agent_id: headers.agent_id,
            task_id: headers.task_id,
            task_type: headers.task_type,
            started_at: task.createdAt,
          });
          insertCall(db, {
            id: task.callId,
            run_id: headers.run_id,
            agent_id: headers.agent_id,
            task_id: headers.task_id,
            task_type: headers.task_type,
            upstream_model: task.clientModel,
            upstream: task.upstreamName,
            dialect: task.dialect,
            prompt_tokens: promptTokens,
            response_tokens: responseTokens,
            total_tokens: promptTokens + responseTokens,
            cache_creation_tokens: cacheCreationTokens,
            cache_read_tokens: cacheReadTokens,
            cost_usd: costUsd,
            system_tokens: inspection?.categories.system ?? 0,
            tool_tokens: inspection?.categories.tools ?? 0,
            memory_tokens: inspection?.categories.memory ?? 0,
            history_tokens: inspection?.categories.history ?? 0,
            tool_output_tokens: inspection?.categories.toolOutput ?? 0,
            unknown_tokens: inspection?.categories.unknown ?? 0,
            request_hash: inspection?.requestHash ?? null,
            stable_prefix_hash: inspection?.stablePrefixHash ?? null,
            latency_ms: task.latencyMs,
            status: rowStatus,
            error_message: null,
            created_at: task.createdAt,
          });
          if (inspection) {
            for (const flag of inspection.flags) {
              insertFlag(db, {
                id: `flag-${nanoid(10)}`,
                run_id: headers.run_id,
                llm_call_id: task.callId,
                flag,
                created_at: new Date().toISOString(),
              });
            }
            for (const block of inspection.repeatedBlocks) {
              insertRepeatedBlock(db, {
                id: `rb-${nanoid(10)}`,
                run_id: headers.run_id,
                llm_call_id: task.callId,
                block,
                created_at: new Date().toISOString(),
              });
            }
            for (const entry of inspection.toolUsage) {
              insertToolUsage(db, {
                id: `tu-${nanoid(10)}`,
                call_id: task.callId,
                run_id: headers.run_id,
                agent_id: headers.agent_id,
                entry,
                created_at: new Date().toISOString(),
              });
            }
            bumpRunTotals(db, {
              run_id: headers.run_id,
              prompt_tokens: promptTokens,
              response_tokens: responseTokens,
              flags_added: inspection.flags.length,
            });
          } else {
            // No inspection for this dialect — still bump run totals so cost
            // summaries reflect the call.
            bumpRunTotals(db, {
              run_id: headers.run_id,
              prompt_tokens: promptTokens,
              response_tokens: responseTokens,
              flags_added: 0,
            });
          }
        },
        undefined,
      );
    } catch (err) {
      return {
        model: task.clientModel,
        promptTokens,
        responseTokens,
        costUsd,
        runId: headers.run_id,
        status: rowStatus,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    model: task.clientModel,
    promptTokens,
    responseTokens,
    costUsd,
    runId: headers.run_id,
    status: rowStatus,
  };
}
