export type Severity = "low" | "medium" | "high";

export type Category =
  | "system"
  | "tools"
  | "memory"
  | "history"
  | "toolOutput"
  | "unknown";

export type ChatMessageRole =
  | "system"
  | "developer"
  | "user"
  | "assistant"
  | "tool"
  | "function";

export interface ChatMessage {
  role: ChatMessageRole;
  content?: string | Array<{ type: string; text?: string; [k: string]: unknown }> | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<Record<string, unknown>>;
  functions?: Array<Record<string, unknown>>;
  stream?: boolean;
  [k: string]: unknown;
}

export interface GuvnahHeaders {
  agent_id: string;
  run_id: string;
  task_id: string | null;
  task_type: string;
}

export type FlagType =
  | "oversized_context"
  | "large_system_prompt"
  | "tool_bloat"
  | "memory_bloat"
  | "history_bloat"
  | "raw_tool_output_bloat"
  | "repeated_block"
  | "cache_hostile_prefix"
  | "cache_thrash"
  | "large_single_message"
  | "unknown_context_mass";

export interface ContextFlag {
  flag_type: FlagType;
  severity: Severity;
  message: string;
  estimated_tokens_involved: number;
  suggestion: string;
}

export interface RepeatedBlock {
  block_hash: string;
  occurrences: number;
  estimated_tokens: number;
  sample_preview: string;
}

export interface CategoryBreakdown {
  system: number;
  tools: number;
  memory: number;
  history: number;
  toolOutput: number;
  unknown: number;
}

export interface PromptInspection {
  promptTokens: number;
  categories: CategoryBreakdown;
  flags: ContextFlag[];
  repeatedBlocks: RepeatedBlock[];
  stablePrefixHash?: string;
  requestHash: string;
  largestMessageTokens: number;
  toolUsage: ToolUsageEntry[];
}

export interface ToolUsageEntry {
  tool_name: string;
  shipped: boolean;
  invoked: boolean;
  description_tokens: number;
}

export interface ToolUsageRow {
  id: string;
  call_id: string;
  run_id: string;
  agent_id: string;
  tool_name: string;
  shipped: number;
  invoked: number;
  description_tokens: number;
  created_at: string;
}

export interface ToolUsageAggregate {
  tool_name: string;
  shipped_calls: number;
  invoked_calls: number;
  total_calls: number;
  avg_description_tokens: number;
  wasted_tokens_est: number;
}

export interface RunRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  task_type: string | null;
  started_at: string;
  ended_at: string | null;
  total_prompt_tokens: number;
  total_response_tokens: number;
  total_calls: number;
  total_flags: number;
}

export interface LlmCallRow {
  id: string;
  run_id: string;
  agent_id: string;
  task_id: string | null;
  task_type: string | null;
  upstream_model: string | null;
  prompt_tokens: number;
  response_tokens: number;
  total_tokens: number;
  system_tokens: number;
  tool_tokens: number;
  memory_tokens: number;
  history_tokens: number;
  tool_output_tokens: number;
  unknown_tokens: number;
  request_hash: string | null;
  stable_prefix_hash: string | null;
  latency_ms: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

export interface FlagRow {
  id: string;
  run_id: string;
  llm_call_id: string;
  flag_type: string;
  severity: string;
  message: string;
  estimated_tokens_involved: number | null;
  suggestion: string | null;
  created_at: string;
}

export interface RepeatedBlockRow {
  id: string;
  run_id: string;
  llm_call_id: string;
  block_hash: string;
  occurrences: number;
  estimated_tokens: number;
  sample_preview: string | null;
  created_at: string;
}
