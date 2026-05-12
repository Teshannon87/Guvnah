import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().positive().default(8791),
  }),
  upstream: z.object({
    base_url: z.string().url().or(z.string().startsWith("http")),
    api_key_env: z.string().default("UPSTREAM_API_KEY"),
    forward_client_auth: z.boolean().default(false),
  }),
  database: z.object({
    path: z.string().default(".guvnah-context/guvnah-context.sqlite"),
  }),
  mode: z.object({
    inspect_only: z.boolean().default(true),
    mutate_prompts: z.boolean().default(false),
  }),
  logging: z.object({
    log_prompts: z.boolean().default(true),
    log_responses: z.boolean().default(false),
    redact_secrets: z.boolean().default(true),
    store_full_prompt: z.boolean().default(false),
    store_prompt_hash: z.boolean().default(true),
  }),
  token_budgets: z.object({
    max_total_prompt_tokens: z.number().int().positive().default(20000),
    max_system_tokens: z.number().int().positive().default(5000),
    max_tools_tokens: z.number().int().positive().default(4000),
    max_memory_tokens: z.number().int().positive().default(3000),
    max_history_tokens: z.number().int().positive().default(6000),
    max_tool_output_tokens: z.number().int().positive().default(3000),
  }),
  detection: z.object({
    repeated_block_min_tokens: z.number().int().positive().default(250),
    repeated_block_min_occurrences: z.number().int().positive().default(2),
    oversized_context_tokens: z.number().int().positive().default(20000),
    large_message_tokens: z.number().int().positive().default(5000),
    raw_tool_output_tokens: z.number().int().positive().default(3000),
    cache_prefix_window_tokens: z.number().int().positive().default(4000),
    cache_thrash_window_minutes: z.number().int().positive().default(5),
    cache_thrash_distinct_hashes: z.number().int().positive().default(2),
    unknown_mass_tokens: z.number().int().positive().default(4000),
  }),
  breaker: z.object({
    enabled: z.boolean().default(true),
    failure_threshold: z.number().int().positive().default(5),
    cooldown_ms: z.number().int().positive().default(30000),
  }),
  pricing: z
    .object({
      use_baseline: z.boolean().default(true),
      use_openrouter_cache: z.boolean().default(true),
      overrides: z
        .array(
          z.object({
            model: z.string(),
            input_per_mtok: z.number().nonnegative(),
            output_per_mtok: z.number().nonnegative(),
          }),
        )
        .default([]),
    })
    .default({}),
  notifications: z
    .object({
      cli: z
        .object({
          enabled: z.boolean().default(true),
          coin_emoji: z.string().default("🪙"),
        })
        .default({}),
    })
    .default({}),
  categories: z.object({
    system: z.object({
      role_patterns: z.array(z.string()).default(["system", "developer"]),
    }),
    tools: z.object({
      keyword_patterns: z.array(z.string()).default([
        "tool",
        "function",
        "skill",
        "available tools",
        "available skills",
        "mcp",
      ]),
    }),
    memory: z.object({
      keyword_patterns: z.array(z.string()).default([
        "memory",
        "memories",
        "user profile",
        "known facts",
        "saved context",
      ]),
    }),
    history: z.object({
      role_patterns: z.array(z.string()).default(["user", "assistant"]),
    }),
    tool_output: z.object({
      keyword_patterns: z.array(z.string()).default([
        "tool result",
        "function result",
        "stdout",
        "stderr",
        "stack trace",
        "html",
        "json",
      ]),
    }),
  }),
});

export type GuvnahConfig = z.infer<typeof ConfigSchema>;
