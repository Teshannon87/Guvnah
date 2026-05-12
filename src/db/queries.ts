import type Database from "better-sqlite3";
import type {
  ContextFlag,
  FlagRow,
  LlmCallRow,
  RepeatedBlock,
  RepeatedBlockRow,
  RunRow,
} from "../types/index.js";

export function ensureRun(
  db: Database.Database,
  args: {
    run_id: string;
    agent_id: string;
    task_id: string | null;
    task_type: string | null;
    started_at: string;
  },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO runs (id, agent_id, task_id, task_type, started_at)
     VALUES (@run_id, @agent_id, @task_id, @task_type, @started_at)`,
  ).run(args);
}

export function insertCall(db: Database.Database, row: LlmCallRow): void {
  db.prepare(
    `INSERT INTO llm_calls (
      id, run_id, agent_id, task_id, task_type, upstream_model,
      prompt_tokens, response_tokens, total_tokens,
      system_tokens, tool_tokens, memory_tokens, history_tokens, tool_output_tokens, unknown_tokens,
      request_hash, stable_prefix_hash, latency_ms, status, error_message, created_at
    ) VALUES (
      @id, @run_id, @agent_id, @task_id, @task_type, @upstream_model,
      @prompt_tokens, @response_tokens, @total_tokens,
      @system_tokens, @tool_tokens, @memory_tokens, @history_tokens, @tool_output_tokens, @unknown_tokens,
      @request_hash, @stable_prefix_hash, @latency_ms, @status, @error_message, @created_at
    )`,
  ).run(row);
}

export function updateCallResult(
  db: Database.Database,
  args: {
    id: string;
    response_tokens: number;
    total_tokens: number;
    latency_ms: number;
    status: string;
    error_message: string | null;
  },
): void {
  db.prepare(
    `UPDATE llm_calls
     SET response_tokens = @response_tokens,
         total_tokens = @total_tokens,
         latency_ms = @latency_ms,
         status = @status,
         error_message = @error_message
     WHERE id = @id`,
  ).run(args);
}

export function insertFlag(
  db: Database.Database,
  args: {
    id: string;
    run_id: string;
    llm_call_id: string;
    flag: ContextFlag;
    created_at: string;
  },
): void {
  db.prepare(
    `INSERT INTO context_flags (
      id, run_id, llm_call_id, flag_type, severity, message,
      estimated_tokens_involved, suggestion, created_at
    ) VALUES (
      @id, @run_id, @llm_call_id, @flag_type, @severity, @message,
      @estimated_tokens_involved, @suggestion, @created_at
    )`,
  ).run({
    id: args.id,
    run_id: args.run_id,
    llm_call_id: args.llm_call_id,
    flag_type: args.flag.flag_type,
    severity: args.flag.severity,
    message: args.flag.message,
    estimated_tokens_involved: args.flag.estimated_tokens_involved,
    suggestion: args.flag.suggestion,
    created_at: args.created_at,
  });
}

export function insertRepeatedBlock(
  db: Database.Database,
  args: {
    id: string;
    run_id: string;
    llm_call_id: string;
    block: RepeatedBlock;
    created_at: string;
  },
): void {
  db.prepare(
    `INSERT INTO repeated_blocks (
      id, run_id, llm_call_id, block_hash, occurrences, estimated_tokens, sample_preview, created_at
    ) VALUES (
      @id, @run_id, @llm_call_id, @block_hash, @occurrences, @estimated_tokens, @sample_preview, @created_at
    )`,
  ).run({
    id: args.id,
    run_id: args.run_id,
    llm_call_id: args.llm_call_id,
    block_hash: args.block.block_hash,
    occurrences: args.block.occurrences,
    estimated_tokens: args.block.estimated_tokens,
    sample_preview: args.block.sample_preview,
    created_at: args.created_at,
  });
}

export function bumpRunTotals(
  db: Database.Database,
  args: {
    run_id: string;
    prompt_tokens: number;
    response_tokens: number;
    flags_added: number;
  },
): void {
  db.prepare(
    `UPDATE runs
     SET total_prompt_tokens = total_prompt_tokens + @prompt_tokens,
         total_response_tokens = total_response_tokens + @response_tokens,
         total_calls = total_calls + 1,
         total_flags = total_flags + @flags_added,
         ended_at = datetime('now')
     WHERE id = @run_id`,
  ).run(args);
}

export function getRun(db: Database.Database, run_id: string): RunRow | null {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(run_id) as RunRow | undefined;
  return row ?? null;
}

export function getCallsForRun(db: Database.Database, run_id: string): LlmCallRow[] {
  return db
    .prepare(`SELECT * FROM llm_calls WHERE run_id = ? ORDER BY created_at ASC`)
    .all(run_id) as LlmCallRow[];
}

export function getFlagsForRun(db: Database.Database, run_id: string): FlagRow[] {
  return db
    .prepare(`SELECT * FROM context_flags WHERE run_id = ? ORDER BY created_at ASC`)
    .all(run_id) as FlagRow[];
}

export function getRepeatedBlocksForRun(
  db: Database.Database,
  run_id: string,
): RepeatedBlockRow[] {
  return db
    .prepare(`SELECT * FROM repeated_blocks WHERE run_id = ? ORDER BY occurrences DESC`)
    .all(run_id) as RepeatedBlockRow[];
}

export function getPriorBlockOccurrences(
  db: Database.Database,
  run_id: string,
  block_hash: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(occurrences), 0) AS n
       FROM repeated_blocks
       WHERE run_id = ? AND block_hash = ?`,
    )
    .get(run_id, block_hash) as { n: number };
  return row.n ?? 0;
}

export function getLastStablePrefixHash(
  db: Database.Database,
  run_id: string,
): string | null {
  const row = db
    .prepare(
      `SELECT stable_prefix_hash FROM llm_calls
       WHERE run_id = ? AND stable_prefix_hash IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(run_id) as { stable_prefix_hash: string } | undefined;
  return row?.stable_prefix_hash ?? null;
}

export function getRecentRuns(
  db: Database.Database,
  opts: { sinceIso?: string; agentId?: string; limit?: number },
): RunRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.sinceIso) {
    clauses.push(`started_at >= @sinceIso`);
    params.sinceIso = opts.sinceIso;
  }
  if (opts.agentId) {
    clauses.push(`agent_id = @agentId`);
    params.agentId = opts.agentId;
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  return db
    .prepare(`SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ${limit}`)
    .all(params) as RunRow[];
}
