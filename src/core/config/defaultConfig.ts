import type { GuvnahConfig } from "./schema.js";

export const defaultConfig: GuvnahConfig = {
  server: { host: "127.0.0.1", port: 8791 },
  upstream: {
    base_url: "http://localhost:8787/v1",
    api_key_env: "UPSTREAM_API_KEY",
    forward_client_auth: false,
  },
  database: { path: ".guvnah-context/guvnah-context.sqlite" },
  mode: { inspect_only: true, mutate_prompts: false },
  logging: {
    log_prompts: true,
    log_responses: false,
    redact_secrets: true,
    store_full_prompt: false,
    store_prompt_hash: true,
  },
  token_budgets: {
    max_total_prompt_tokens: 20000,
    max_system_tokens: 5000,
    max_tools_tokens: 4000,
    max_memory_tokens: 3000,
    max_history_tokens: 6000,
    max_tool_output_tokens: 3000,
  },
  detection: {
    repeated_block_min_tokens: 250,
    repeated_block_min_occurrences: 2,
    oversized_context_tokens: 20000,
    large_message_tokens: 5000,
    raw_tool_output_tokens: 3000,
    cache_prefix_window_tokens: 4000,
    cache_thrash_window_minutes: 5,
    cache_thrash_distinct_hashes: 2,
    unknown_mass_tokens: 4000,
  },
  breaker: { enabled: true, failure_threshold: 5, cooldown_ms: 30000 },
  pricing: {
    use_baseline: true,
    use_openrouter_cache: true,
    overrides: [],
  },
  notifications: {
    cli: {
      enabled: true,
      coin_emoji: "🪙",
      end_of_run: {
        enabled: true,
        idle_seconds: 60,
        sweep_interval_seconds: 10,
      },
    },
  },
  categories: {
    system: { role_patterns: ["system", "developer"] },
    tools: {
      keyword_patterns: [
        "tool",
        "function",
        "skill",
        "available tools",
        "available skills",
        "mcp",
      ],
    },
    memory: {
      keyword_patterns: [
        "memory",
        "memories",
        "user profile",
        "known facts",
        "saved context",
      ],
    },
    history: { role_patterns: ["user", "assistant"] },
    tool_output: {
      keyword_patterns: [
        "tool result",
        "function result",
        "stdout",
        "stderr",
        "stack trace",
        "html",
        "json",
      ],
    },
  },
};
