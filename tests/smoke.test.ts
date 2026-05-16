import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as undiciRequest } from "undici";
import { startStubUpstream, type StubUpstream } from "./helpers/stubUpstream.js";
import { createServer } from "../src/server/createServer.js";
import { openDatabase, closeDatabase } from "../src/db/client.js";
import { defaultConfig } from "../src/core/config/defaultConfig.js";
import { createInlinePool, type AnalysisPool } from "../src/core/analysis/pool.js";
import analyzeInline from "../src/core/analysis/worker.js";
import { buildRunReport } from "../src/core/reports/buildRunReport.js";
import { formatRunReport } from "../src/core/reports/formatRunReport.js";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../src/core/config/schema.js";

interface Ctx {
  tmp: string;
  stub: StubUpstream;
  config: GuvnahConfig;
  db: Database.Database;
  guvnah: FastifyInstance;
  guvnahUrl: string;
  pool: AnalysisPool;
}

async function bootCtx(): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "guvnah-"));
  const stub = await startStubUpstream();
  const config: GuvnahConfig = {
    ...defaultConfig,
    upstream: {
      ...defaultConfig.upstream,
      base_url: `${stub.url}/v1`,
      forward_client_auth: false,
    },
    database: { path: join(tmp, "guvnah.sqlite") },
    detection: {
      ...defaultConfig.detection,
      repeated_block_min_tokens: 100,
    },
    token_budgets: {
      ...defaultConfig.token_budgets,
      max_tools_tokens: 200,
    },
  };
  const handle = openDatabase(config.database.path);
  if (!handle.db) throw new Error(`DB failed: ${handle.error?.message}`);
  const db = handle.db;
  const pool = createInlinePool(analyzeInline);
  const guvnah = await createServer({ config, db, version: "test", pool, dbPath: config.database.path });
  const guvnahUrl = await guvnah.listen({ host: "127.0.0.1", port: 0 });
  return { tmp, stub, config, db, guvnah, guvnahUrl, pool };
}

async function shutdownCtx(ctx: Ctx): Promise<void> {
  await ctx.guvnah.close();
  await ctx.stub.close();
  closeDatabase({ db: ctx.db, path: ctx.config.database.path, error: null });
  rmSync(ctx.tmp, { recursive: true, force: true });
}

describe("Guvnah smoke", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await bootCtx();
  });
  afterEach(async () => {
    await shutdownCtx(ctx);
  });

  it("forwards a bloated request, logs inspection, and produces a useful report", async () => {
    const body = readFileSync(
      new URL("./fixtures/bloated-request.json", import.meta.url),
      "utf8",
    );
    const res = await undiciRequest(`${ctx.guvnahUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-guvnah-agent-id": "test-agent",
        "x-guvnah-run-id": "smoke-run-1",
        "x-guvnah-task-id": "refactor-auth",
        "x-guvnah-task-type": "code",
      },
      body,
    });
    expect(res.statusCode).toBe(200);
    const json = await res.body.json() as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe("ack");
    expect(ctx.stub.callCount()).toBe(1);

    // Analysis runs off the request path; wait for it before reading DB.
    await ctx.pool.drain?.();
    const report = buildRunReport(ctx.db, "smoke-run-1");
    expect(report).not.toBeNull();
    expect(report!.totals.total_calls).toBe(1);
    expect(report!.totals.total_prompt_tokens).toBeGreaterThan(0);
    expect(report!.totals.categories.tools).toBeGreaterThan(0);
    expect(report!.totals.categories.history).toBeGreaterThan(0);

    const flagTypes = new Set(report!.flags.map((f) => f.flag_type));
    expect(flagTypes.has("repeated_block")).toBe(true);
    expect(flagTypes.has("tool_bloat") || flagTypes.has("large_system_prompt")).toBe(true);

    const text = formatRunReport(report!);
    expect(text).toContain("Run: smoke-run-1");
    expect(text).toContain("Context breakdown:");
    expect(text).toContain("Top context bloat flags:");
  });

  it("forwards streaming requests instead of rejecting them", async () => {
    const res = await undiciRequest(`${ctx.guvnahUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    // Streaming is now supported — must not 400 with stream_not_supported.
    expect(res.statusCode).not.toBe(400);
    expect(ctx.stub.callCount()).toBe(1);
  });

  it("preserves upstream response bytes", async () => {
    const res = await undiciRequest(`${ctx.guvnahUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = await res.body.json() as { object: string; id: string };
    expect(body.object).toBe("chat.completion");
    expect(body.id).toMatch(/^chatcmpl-stub-/);
  });
});
