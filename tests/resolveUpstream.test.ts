import { describe, expect, it } from "vitest";
import { resolveUpstream } from "../src/core/proxy/resolveUpstream.js";
import { defaultConfig } from "../src/core/config/defaultConfig.js";
import type { GuvnahConfig } from "../src/core/config/schema.js";

function makeConfig(over: Partial<GuvnahConfig>): GuvnahConfig {
  return { ...defaultConfig, ...over } as GuvnahConfig;
}

describe("resolveUpstream", () => {
  it("falls back to legacy upstream when upstreams map is empty", () => {
    const cfg = makeConfig({});
    const r = resolveUpstream("gpt-4o", cfg);
    expect(r.source).toBe("legacy");
    expect(r.name).toBe("legacy");
    expect(r.forwarded_model).toBe("gpt-4o");
  });

  it("routes by model prefix when configured", () => {
    const cfg = makeConfig({
      upstreams: {
        hermes: {
          base_url: "http://127.0.0.1:8642/v1",
          api_key_env: "HERMES_API_KEY",
          auth: "bearer",
          extra_headers: {},
        },
        anthropic: {
          base_url: "https://api.anthropic.com/v1",
          api_key_env: "ANTHROPIC_API_KEY",
          auth: "x-api-key",
          extra_headers: { "anthropic-version": "2023-06-01" },
        },
      },
    });
    const h = resolveUpstream("hermes/llama-3.3-70b", cfg);
    expect(h.source).toBe("model_prefix");
    expect(h.name).toBe("hermes");
    expect(h.forwarded_model).toBe("llama-3.3-70b");
    expect(h.auth).toBe("bearer");

    const a = resolveUpstream("anthropic/claude-haiku-4-5", cfg);
    expect(a.source).toBe("model_prefix");
    expect(a.name).toBe("anthropic");
    expect(a.forwarded_model).toBe("claude-haiku-4-5");
    expect(a.auth).toBe("x-api-key");
    expect(a.extra_headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("preserves remaining segments for OpenRouter-style nested prefixes", () => {
    const cfg = makeConfig({
      upstreams: {
        openrouter: {
          base_url: "https://openrouter.ai/api/v1",
          api_key_env: "OPENROUTER_API_KEY",
          auth: "bearer",
          extra_headers: {},
        },
      },
    });
    const r = resolveUpstream("openrouter/anthropic/claude-opus-4-7", cfg);
    expect(r.name).toBe("openrouter");
    expect(r.forwarded_model).toBe("anthropic/claude-opus-4-7");
  });

  it("falls back to default_upstream when prefix is unknown", () => {
    const cfg = makeConfig({
      upstreams: {
        openai: {
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
          auth: "bearer",
          extra_headers: {},
        },
      },
      default_upstream: "openai",
    });
    const r = resolveUpstream("gpt-5", cfg);
    expect(r.source).toBe("default_upstream");
    expect(r.name).toBe("openai");
    expect(r.forwarded_model).toBe("gpt-5");
  });

  it("falls back to legacy when an unknown prefix has no default_upstream", () => {
    const cfg = makeConfig({
      upstreams: {
        openai: {
          base_url: "https://api.openai.com/v1",
          api_key_env: "OPENAI_API_KEY",
          auth: "bearer",
          extra_headers: {},
        },
      },
    });
    // Unknown prefix "ollama" — no default set, so should fall through to legacy.
    const r = resolveUpstream("ollama/llama3", cfg);
    expect(r.source).toBe("legacy");
  });
});
