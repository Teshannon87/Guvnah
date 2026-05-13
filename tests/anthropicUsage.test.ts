import { describe, expect, it } from "vitest";
import {
  extractAnthropicUsage,
  extractAnthropicStreamingUsage,
} from "../src/core/proxy/anthropicUsage.js";

describe("anthropicUsage", () => {
  it("extracts top-level usage from non-streaming response", () => {
    const body = Buffer.from(
      JSON.stringify({
        id: "msg_01",
        type: "message",
        content: [{ type: "text", text: "ok" }],
        usage: {
          input_tokens: 18600,
          output_tokens: 3,
          cache_creation_input_tokens: 1200,
          cache_read_input_tokens: 15000,
        },
      }),
    );
    const u = extractAnthropicUsage(body);
    expect(u.inputTokens).toBe(18600);
    expect(u.outputTokens).toBe(3);
    expect(u.cacheCreationTokens).toBe(1200);
    expect(u.cacheReadTokens).toBe(15000);
  });

  it("returns zeros when usage is absent", () => {
    const u = extractAnthropicUsage(Buffer.from("{}"));
    expect(u).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
  });

  it("extracts streaming usage from message_start + message_delta events", () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":12000,"output_tokens":1,"cache_creation_input_tokens":500,"cache_read_input_tokens":10000}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start"}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join("\n");
    const u = extractAnthropicStreamingUsage(Buffer.from(sse));
    expect(u.inputTokens).toBe(12000);
    expect(u.outputTokens).toBe(7);
    expect(u.cacheCreationTokens).toBe(500);
    expect(u.cacheReadTokens).toBe(10000);
  });

  it("handles streams where message_delta arrives without usage", () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    ].join("\n\n");
    const u = extractAnthropicStreamingUsage(Buffer.from(sse));
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(1);
  });
});
