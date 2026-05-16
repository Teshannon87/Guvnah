import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as undiciRequest } from "undici";
import type { FastifyInstance } from "fastify";
import { CircuitBreaker } from "../src/core/proxy/circuitBreaker.js";
import { createServer } from "../src/server/createServer.js";
import { defaultConfig } from "../src/core/config/defaultConfig.js";
import { startStubUpstream, type StubUpstream } from "./helpers/stubUpstream.js";
import { createInlinePool } from "../src/core/analysis/pool.js";
import analyzeInline from "../src/core/analysis/worker.js";

describe("CircuitBreaker unit", () => {
  it("returns the fallback on failure without rethrowing", async () => {
    const cb = new CircuitBreaker({ enabled: true, failure_threshold: 3, cooldown_ms: 100 });
    const result = await cb.run("test", () => {
      throw new Error("boom");
    }, "fallback-value");
    expect(result).toBe("fallback-value");
  });

  it("opens after the threshold and short-circuits subsequent calls", async () => {
    const cb = new CircuitBreaker({ enabled: true, failure_threshold: 3, cooldown_ms: 10_000 });
    let invocations = 0;
    const failingFn = () => {
      invocations++;
      throw new Error("nope");
    };
    for (let i = 0; i < 3; i++) {
      await cb.run("svc", failingFn, "fallback");
    }
    expect(invocations).toBe(3);
    expect(cb.isOpen("svc")).toBe(true);

    const r = await cb.run("svc", failingFn, "fallback");
    expect(r).toBe("fallback");
    expect(invocations).toBe(3); // not invoked while open
  });

  it("half-opens after cooldown and recovers on success", async () => {
    const cb = new CircuitBreaker({ enabled: true, failure_threshold: 2, cooldown_ms: 25 });
    await cb.run("svc", () => { throw new Error("a"); }, null);
    await cb.run("svc", () => { throw new Error("b"); }, null);
    expect(cb.isOpen("svc")).toBe(true);

    await new Promise((r) => setTimeout(r, 40));
    const r = await cb.run("svc", () => "recovered", null);
    expect(r).toBe("recovered");
    expect(cb.isOpen("svc")).toBe(false);
  });
});

describe("Proxy resilience", () => {
  let stub: StubUpstream;
  let guvnah: FastifyInstance;
  let guvnahUrl: string;

  beforeEach(async () => {
    stub = await startStubUpstream();
    // db: null simulates SQLite being unavailable at startup.
    guvnah = await createServer({
      config: {
        ...defaultConfig,
        upstream: { ...defaultConfig.upstream, base_url: `${stub.url}/v1` },
      },
      db: null,
      version: "test",
      pool: createInlinePool(analyzeInline),
    });
    guvnahUrl = await guvnah.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await guvnah.close();
    await stub.close();
  });

  it("forwards requests successfully even when the DB is unavailable", async () => {
    const res = await undiciRequest(`${guvnahUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.statusCode).toBe(200);
    const json = await res.body.json() as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe("ack");
    expect(stub.callCount()).toBe(1);
  });

  it("returns 502 with a clear error when the upstream is unreachable", async () => {
    // Force the upstream URL to a port nothing is listening on.
    await guvnah.close();
    guvnah = await createServer({
      config: {
        ...defaultConfig,
        upstream: { ...defaultConfig.upstream, base_url: "http://127.0.0.1:1/v1" },
      },
      db: null,
      version: "test",
      pool: createInlinePool(analyzeInline),
    });
    guvnahUrl = await guvnah.listen({ host: "127.0.0.1", port: 0 });

    const res = await undiciRequest(`${guvnahUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.statusCode).toBe(502);
    const err = await res.body.json() as { error: { code: string } };
    expect(err.error.code).toBe("upstream_unreachable");
  });
});
