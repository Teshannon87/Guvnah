import type { GuvnahHeaders } from "../../types/index.js";

function header(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function fallbackRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `run-${ts}-${rand}`;
}

export function extractGuvnahHeaders(
  rawHeaders: Record<string, string | string[] | undefined>,
): GuvnahHeaders {
  return {
    agent_id: header(rawHeaders, "x-guvnah-agent-id") ?? "unknown-agent",
    run_id: header(rawHeaders, "x-guvnah-run-id") ?? fallbackRunId(),
    task_id: header(rawHeaders, "x-guvnah-task-id"),
    task_type: header(rawHeaders, "x-guvnah-task-type") ?? "unknown",
  };
}
