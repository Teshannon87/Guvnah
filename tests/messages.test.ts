import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as undiciRequest } from "undici";
import { startStubAnthropicUpstream, type StubAnthropicUpstream } from "./helpers/stubAnthropicUpstream.js";
import { createServer } from "../src/server/createServer.js";
import { openDatabase, closeDatabase } from "../src/db/client.js";
import { defaultConfig } from "../src/core/config/defaultConfig.js";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { GuvnahConfig } from "../src/core/config/schema.js";

interface Ctx {
  tmp: string;
  stub: StubAnthropicUpstream;
  config: GuvnahConfig;
  db: Database.Database;
  guvnah: FastifyInstance;
  guvnahUrl: string;
}

async function bootCtx(): Promise<Ctx> {
  const tmp = mkdtempSync(join(tmpdir(), "guvnah-msgs-"));
  const stub = await startStubAnthropicUpstream();
  // Use the new `upstreams` map + model-prefix routing.
  const config: GuvnahConfig = {
    ...defaultConfig,
    upstreams: {
      anthropic: {
        base_url: `${stub.url}/v1`,
        api_key_env: "STUB_ANTHROPIC_KEY",
        auth: "x-api-key",
        extra_headers: { "anthropic-version": "2023-06-01" },
      },
    },
    database: { path: join(tmp, "guvnah.sqlite") },
  };
  process.env.STUB_ANTHROPIC_KEY = "test-key-abc";
  const handle = openDatabase(config.database.path);
  if (!handle.db) throw new Error(`DB failed: ${handle.error?.message}`);
  const db = handle.db;
  const guvnah = await createServer({ config, db, version: "test" });
  const guvnahUrl = await guvnah.listen({ host: "127.0.0.1", port: 0 });
  return { tmp, stub, config, db, guvnah, guvnahUrl };
}

async function shutdownCtx(ctx: Ctx): Promise<void> {
  await ctx.guvnah.close();
  await ctx.stub.close();
  closeDatabase({ db: ctx.db, path: ctx.config.database.path, error: null });
  rmSync(ctx.tmp, { recursive: true, force: true });
  delete process.env.STUB_ANTHROPIC_KEY;
}

describe("Anthropic /v1/messages route", () => {
  let ctx: Ctx;
  beforeEach(async () => { ctx = await bootCtx(); });
  afterEach(async () => { await shutdownCtx(ctx); });

  it("routes anthropic/<model> to the anthropic upstream and logs cache tokens + cost", async () => {
    const res = await undiciRequest(`${ctx.guvnahUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-guvnah-agent-id": "test-agent",
        "x-guvnah-run-id": "msgs-run-1",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.statusCode).toBe(200);
    const json = (await res.body.json()) as { content: Array<{ text: string }> };
    expect(json.content[0]!.text).toBe("ack");
    expect(ctx.stub.callCount()).toBe(1);

    // Auth header was swapped to x-api-key from STUB_ANTHROPIC_KEY env, and the
    // model prefix was stripped before forwarding.
    const upstreamHeaders = ctx.stub.lastHeaders();
    expect(upstreamHeaders["x-api-key"]).toBe("test-key-abc");
    expect(upstreamHeaders["anthropic-version"]).toBe("2023-06-01");
    const upstreamBody = ctx.stub.lastBody() as { model: string };
    expect(upstreamBody.model).toBe("claude-haiku-4-5");

    const row = ctx.db
      .prepare(
        `SELECT dialect, upstream, upstream_model, prompt_tokens, response_tokens,
                cache_creation_tokens, cache_read_tokens, cost_usd, status
         FROM llm_calls WHERE run_id = ?`,
      )
      .get("msgs-run-1") as {
        dialect: string;
        upstream: string;
        upstream_model: string;
        prompt_tokens: number;
        response_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        cost_usd: number;
        status: string;
      };
    expect(row.dialect).toBe("anthropic");
    expect(row.upstream).toBe("anthropic");
    expect(row.upstream_model).toBe("anthropic/claude-haiku-4-5");
    expect(row.prompt_tokens).toBe(1000);
    expect(row.response_tokens).toBe(5);
    expect(row.cache_creation_tokens).toBe(200);
    expect(row.cache_read_tokens).toBe(800);
    expect(row.status).toBe("ok");
    // Haiku 4-5: 1.00 in / 5.00 out per Mtok.
    //   base in:    1000 / 1M * 1.00       = 0.001
    //   cache write: 200 / 1M * 1.00 * 1.25 = 0.00025
    //   cache read:  800 / 1M * 1.00 * 0.10 = 0.00008
    //   out:           5 / 1M * 5.00       = 0.000025
    //   total ≈ 0.001355
    expect(row.cost_usd).toBeCloseTo(0.001355, 6);
  });
});
