import { request } from "undici";
import type { GuvnahConfig } from "../config/schema.js";

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  latencyMs: number;
}

export interface UpstreamStreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
  startedAt: number;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function buildHeaders(
  incoming: Record<string, string | string[] | undefined>,
  upstream: GuvnahConfig["upstream"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("x-guvnah-")) continue;
    if (lower === "authorization" && !upstream.forward_client_auth) continue;
    if (typeof v === "string") out[lower] = v;
    else if (Array.isArray(v) && v.length > 0) out[lower] = v.join(",");
  }
  if (!upstream.forward_client_auth) {
    const key = process.env[upstream.api_key_env];
    if (key) out["authorization"] = `Bearer ${key}`;
  }
  out["content-type"] = "application/json";
  return out;
}

function normalizeResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(",");
  }
  return out;
}

export async function forwardChatCompletion(args: {
  bodyBytes: Buffer;
  headers: Record<string, string | string[] | undefined>;
  config: GuvnahConfig;
}): Promise<UpstreamResponse> {
  const { config, bodyBytes } = args;
  const url = `${config.upstream.base_url.replace(/\/$/, "")}/chat/completions`;
  const headers = buildHeaders(args.headers, config.upstream);
  const started = Date.now();
  const res = await request(url, {
    method: "POST",
    headers,
    body: bodyBytes,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  return {
    status: res.statusCode,
    headers: normalizeResponseHeaders(res.headers),
    body,
    latencyMs: Date.now() - started,
  };
}

export async function forwardChatCompletionStream(args: {
  bodyBytes: Buffer;
  headers: Record<string, string | string[] | undefined>;
  config: GuvnahConfig;
}): Promise<UpstreamStreamResponse> {
  const { config, bodyBytes } = args;
  const url = `${config.upstream.base_url.replace(/\/$/, "")}/chat/completions`;
  const headers = buildHeaders(args.headers, config.upstream);
  const started = Date.now();
  const res = await request(url, {
    method: "POST",
    headers,
    body: bodyBytes,
  });
  return {
    status: res.statusCode,
    headers: normalizeResponseHeaders(res.headers),
    body: res.body as unknown as AsyncIterable<Buffer>,
    startedAt: started,
  };
}
