import { request } from "undici";
import type { GuvnahConfig } from "../config/schema.js";
import { resolveUpstream, type LegacyUpstream, type ResolvedUpstream } from "./resolveUpstream.js";

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  latencyMs: number;
  upstream_name: string;
  forwarded_model: string;
}

export interface UpstreamStreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
  startedAt: number;
  upstream_name: string;
  forwarded_model: string;
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
  upstream: ResolvedUpstream | LegacyUpstream,
): Record<string, string> {
  const out: Record<string, string> = {};
  const isLegacy = upstream.source === "legacy";
  const forwardClientAuth = isLegacy ? (upstream as LegacyUpstream).forward_client_auth : false;

  for (const [k, v] of Object.entries(incoming)) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("x-guvnah-")) continue;
    // Strip the client's auth header unless legacy forward_client_auth is on,
    // since we may be substituting a different upstream's key.
    if (lower === "authorization" && !forwardClientAuth) continue;
    if (lower === "x-api-key" && !forwardClientAuth) continue;
    if (typeof v === "string") out[lower] = v;
    else if (Array.isArray(v) && v.length > 0) out[lower] = v.join(",");
  }

  if (!forwardClientAuth) {
    const key = upstream.api_key_env ? process.env[upstream.api_key_env] : undefined;
    if (upstream.auth === "bearer") {
      if (key) out["authorization"] = `Bearer ${key}`;
    } else if (upstream.auth === "x-api-key") {
      if (key) out["x-api-key"] = key;
    }
    // auth === "none" → send no auth headers
  }

  for (const [k, v] of Object.entries(upstream.extra_headers ?? {})) {
    out[k.toLowerCase()] = v;
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

function rewriteBodyModel(bodyBytes: Buffer, forwardedModel: string): Buffer {
  // Replace the `model` field in the JSON body with the forwarded (un-prefixed) model name.
  // No-op if the body isn't parseable JSON or doesn't have a model field.
  try {
    const obj = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
    if (typeof obj.model !== "string") return bodyBytes;
    if (obj.model === forwardedModel) return bodyBytes;
    obj.model = forwardedModel;
    return Buffer.from(JSON.stringify(obj), "utf8");
  } catch {
    return bodyBytes;
  }
}

function buildPath(upstream: ResolvedUpstream | LegacyUpstream, route: "chat" | "messages"): string {
  const base = upstream.base_url.replace(/\/$/, "");
  return route === "chat" ? `${base}/chat/completions` : `${base}/messages`;
}

export async function forwardChatCompletion(args: {
  bodyBytes: Buffer;
  headers: Record<string, string | string[] | undefined>;
  config: GuvnahConfig;
  upstream?: ResolvedUpstream | LegacyUpstream;
  route?: "chat" | "messages";
}): Promise<UpstreamResponse> {
  const route = args.route ?? "chat";
  const model = extractModelFromBody(args.bodyBytes);
  const upstream = args.upstream ?? resolveUpstream(model, args.config);
  const body =
    upstream.source !== "legacy" && upstream.forwarded_model
      ? rewriteBodyModel(args.bodyBytes, upstream.forwarded_model)
      : args.bodyBytes;
  const url = buildPath(upstream, route);
  const headers = buildHeaders(args.headers, upstream);
  const started = Date.now();
  const res = await request(url, {
    method: "POST",
    headers,
    body,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const out = Buffer.concat(chunks);
  return {
    status: res.statusCode,
    headers: normalizeResponseHeaders(res.headers),
    body: out,
    latencyMs: Date.now() - started,
    upstream_name: upstream.name,
    forwarded_model: upstream.forwarded_model,
  };
}

export async function forwardChatCompletionStream(args: {
  bodyBytes: Buffer;
  headers: Record<string, string | string[] | undefined>;
  config: GuvnahConfig;
  upstream?: ResolvedUpstream | LegacyUpstream;
  route?: "chat" | "messages";
}): Promise<UpstreamStreamResponse> {
  const route = args.route ?? "chat";
  const model = extractModelFromBody(args.bodyBytes);
  const upstream = args.upstream ?? resolveUpstream(model, args.config);
  const body =
    upstream.source !== "legacy" && upstream.forwarded_model
      ? rewriteBodyModel(args.bodyBytes, upstream.forwarded_model)
      : args.bodyBytes;
  const url = buildPath(upstream, route);
  const headers = buildHeaders(args.headers, upstream);
  const started = Date.now();
  const res = await request(url, {
    method: "POST",
    headers,
    body,
  });
  return {
    status: res.statusCode,
    headers: normalizeResponseHeaders(res.headers),
    body: res.body as unknown as AsyncIterable<Buffer>,
    startedAt: started,
    upstream_name: upstream.name,
    forwarded_model: upstream.forwarded_model,
  };
}

function extractModelFromBody(bodyBytes: Buffer): string | null {
  try {
    const obj = JSON.parse(bodyBytes.toString("utf8")) as { model?: unknown };
    return typeof obj.model === "string" ? obj.model : null;
  } catch {
    return null;
  }
}
