import type { FastifyInstance } from "fastify";

export function registerHealthRoute(app: FastifyInstance, version: string): void {
  app.get("/health", async () => ({ ok: true, version }));
  app.get("/", async () => ({
    name: "guvnah-context",
    version,
    docs: "https://github.com/teshannon87/guvnah",
  }));
}
