import Fastify, { type FastifyInstance } from "fastify";

export interface StubUpstream {
  app: FastifyInstance;
  url: string;
  callCount: () => number;
  lastBody: () => unknown;
  close: () => Promise<void>;
}

export async function startStubUpstream(): Promise<StubUpstream> {
  const app = Fastify({ logger: false });
  let calls = 0;
  let last: unknown = null;
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );
  app.post("/v1/chat/completions", async (req, reply) => {
    calls += 1;
    last = req.body;
    reply.header("content-type", "application/json");
    return {
      id: `chatcmpl-stub-${calls}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: "stub-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "ack" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    };
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    app,
    url,
    callCount: () => calls,
    lastBody: () => last,
    close: async () => {
      await app.close();
    },
  };
}
