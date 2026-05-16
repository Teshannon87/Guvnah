import type { GuvnahConfig } from "../config/schema.js";
import type { GuvnahHeaders } from "../../types/index.js";

export type Dialect = "openai" | "anthropic";

export interface AnalysisTask {
  callId: string;
  createdAt: string;
  dialect: Dialect;
  // Bytes received from the client (the request body Guvnah forwarded).
  requestBody: Buffer;
  // Bytes received from the upstream (full body if non-streaming, concatenated
  // SSE if streaming). Buffer transfer is zero-copy in piscina.
  responseBody: Buffer;
  // Was this a streaming response? Drives the usage-parser selection.
  streaming: boolean;
  // HTTP status from upstream — drives ok vs upstream_error.
  status: number;
  // Wall-clock time the upstream call took, ms.
  latencyMs: number;
  // Which configured upstream served this request (e.g., "hermes", "anthropic",
  // "legacy"). Stored on the row for later filtering.
  upstreamName: string;
  // The model name the client sent (with any provider prefix). Used for pricing
  // lookup; the prefix-stripped model goes upstream but isn't stored.
  clientModel: string | null;
  // Metadata extracted from x-guvnah-* headers.
  guvnahHeaders: GuvnahHeaders;
  // Snapshot of the active config (Zod-validated). Workers re-use it without
  // touching disk. Buffers + this object are the worker's whole input.
  config: GuvnahConfig;
  // Path to the SQLite DB so the worker can open its own connection.
  dbPath: string | null;
}

export interface AnalysisResult {
  // What we wrote (for the cost-line emit on the main thread).
  model: string | null;
  promptTokens: number;
  responseTokens: number;
  costUsd: number | null;
  runId: string;
  // Status the row landed in.
  status: "ok" | "upstream_error";
  // Non-fatal error encountered during analysis (logged, not surfaced to client).
  error?: string;
}
