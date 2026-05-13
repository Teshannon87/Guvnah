import Fastify, { type FastifyInstance } from "fastify";

export interface StubAnthropicUpstream {
  app: FastifyInstance;
  url: string;
  callCount: () => number;
  lastBody: () => unknown;
  lastHeaders: () => Record<string, string | string[] | undefined>;
  close: () => Promise<void>;
}

export async function startStubAnthropicUpstream(): Promise<StubAnthropicUpstream> {
  const app = Fastify({ logger: false });
  let calls = 0;
  let last: unknown = null;
  let lastHeaders: Record<string, string | string[] | undefined> = {};
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try { done(null, JSON.parse(body as string)); } catch (err) { done(err as Error, undefined); }
    },
  );
  app.post("/v1/messages", async (req, reply) => {
    calls += 1;
    last = req.body;
    lastHeaders = req.headers;
    reply.header("content-type", "application/json");
    return {
      id: `msg_stub_${calls}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ack" }],
      model: "stub-model",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1000,
        output_tokens: 5,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 800,
      },
    };
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    url,
    callCount: () => calls,
    lastBody: () => last,
    lastHeaders: () => lastHeaders,
    close: async () => { await app.close(); },
  };
}
