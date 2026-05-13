// Parsers for Anthropic's native /v1/messages API.
//
// Streaming format (SSE with named events):
//   event: message_start
//   data: {"message":{"usage":{"input_tokens": N, "cache_creation_input_tokens": M, "cache_read_input_tokens": K}}}
//   ...
//   event: message_delta
//   data: {"usage":{"output_tokens": N}}
//
// Non-streaming: usage lives at the top level of the JSON response.

export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

const EMPTY: AnthropicUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function readUsage(u: UsageShape | undefined): Partial<AnthropicUsage> {
  if (!u) return {};
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheCreationTokens: u.cache_creation_input_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
  };
}

export function extractAnthropicUsage(body: Buffer): AnthropicUsage {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as {
      usage?: UsageShape;
    };
    const u = readUsage(parsed.usage);
    return {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheCreationTokens: u.cacheCreationTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
    };
  } catch {
    return EMPTY;
  }
}

export function extractAnthropicStreamingUsage(buffered: Buffer): AnthropicUsage {
  // Walk the SSE stream and accumulate usage. message_start carries input + cache
  // fields; message_delta carries the final output_tokens (cumulative).
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  try {
    const text = buffered.toString("utf8");
    const lines = text.split("\n").filter((l) => l.startsWith("data: "));
    for (const line of lines) {
      const payload = line.slice(6).trim();
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload) as {
          type?: string;
          message?: { usage?: UsageShape };
          usage?: UsageShape;
        };
        if (obj.type === "message_start" && obj.message?.usage) {
          const u = readUsage(obj.message.usage);
          if (u.inputTokens !== undefined) inputTokens = u.inputTokens;
          if (u.cacheCreationTokens !== undefined) cacheCreationTokens = u.cacheCreationTokens;
          if (u.cacheReadTokens !== undefined) cacheReadTokens = u.cacheReadTokens;
          if (u.outputTokens !== undefined) outputTokens = u.outputTokens;
        } else if (obj.type === "message_delta" && obj.usage) {
          const u = readUsage(obj.usage);
          if (u.outputTokens !== undefined) outputTokens = u.outputTokens;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens };
}
