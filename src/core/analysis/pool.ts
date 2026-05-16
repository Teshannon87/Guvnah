// Thin wrapper over Piscina. Tests inject a synchronous in-process analyzer
// (the worker function imported directly) so they don't need a built dist or
// real worker threads. Production wires the file-based pool.

import { Piscina } from "piscina";
import { logger } from "../logging/logger.js";
import type { AnalysisResult, AnalysisTask } from "./types.js";

export interface AnalysisPool {
  submit(task: AnalysisTask): Promise<AnalysisResult>;
  close(): Promise<void>;
  // Waits until every submitted task has settled. Optional — tests rely on it
  // to assert on async DB state; production code shouldn't need it.
  drain?(): Promise<void>;
}

export function createPiscinaPool(workerFilePath: string, opts?: { maxThreads?: number }): AnalysisPool {
  const pool = new Piscina<AnalysisTask, AnalysisResult>({
    filename: workerFilePath,
    maxThreads: opts?.maxThreads ?? Math.max(2, Math.min(8, (require("node:os").cpus()?.length ?? 4) - 1)),
    // Don't queue forever — protects memory if analysis is slower than ingest.
    maxQueue: 1024,
    idleTimeout: 30_000,
  });
  return {
    async submit(task) {
      return pool.run(task);
    },
    async close() {
      await pool.destroy();
    },
  };
}

// In-process pool — runs the analyzer on the main thread, useful for tests
// and for environments that can't spawn workers. Tracks inflight submissions
// so drain() can be awaited.
export function createInlinePool(
  analyzer: (task: AnalysisTask) => Promise<AnalysisResult>,
): AnalysisPool {
  const inflight = new Set<Promise<unknown>>();
  return {
    submit(task) {
      const p = analyzer(task);
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      return p;
    },
    async close() {
      // nothing to close
    },
    async drain() {
      while (inflight.size > 0) {
        await Promise.allSettled(Array.from(inflight));
      }
    },
  };
}

// Fire a task at the pool without making the caller await. Logs but does not
// throw on failure — analysis is best-effort and must not affect the client.
export function offload(pool: AnalysisPool, task: AnalysisTask): void {
  pool.submit(task).then(
    (result) => {
      if (result.error) {
        logger.warn("guvnah.analysis.error", { error: result.error, call_id: task.callId });
      }
    },
    (err) => {
      logger.warn("guvnah.analysis.error", {
        error: err instanceof Error ? err.message : String(err),
        call_id: task.callId,
      });
    },
  );
}
