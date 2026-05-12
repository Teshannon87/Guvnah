import { logger } from "../logging/logger.js";

export interface BreakerConfig {
  enabled: boolean;
  failure_threshold: number;
  cooldown_ms: number;
}

interface StageState {
  consecutiveFailures: number;
  openUntil: number;
  isOpen: boolean;
}

export class CircuitBreaker {
  private states = new Map<string, StageState>();
  constructor(private cfg: BreakerConfig) {}

  private getState(stage: string): StageState {
    let s = this.states.get(stage);
    if (!s) {
      s = { consecutiveFailures: 0, openUntil: 0, isOpen: false };
      this.states.set(stage, s);
    }
    return s;
  }

  isOpen(stage: string): boolean {
    if (!this.cfg.enabled) return false;
    const s = this.getState(stage);
    if (s.isOpen && Date.now() >= s.openUntil) {
      // half-open: allow one trial call
      s.isOpen = false;
      logger.warn("guvnah.breaker.half_open", { stage });
    }
    return s.isOpen;
  }

  recordSuccess(stage: string): void {
    const s = this.getState(stage);
    if (s.consecutiveFailures > 0 || s.isOpen) {
      logger.info("guvnah.breaker.closed", { stage });
    }
    s.consecutiveFailures = 0;
    s.isOpen = false;
    s.openUntil = 0;
  }

  recordFailure(stage: string, error: unknown): void {
    const s = this.getState(stage);
    s.consecutiveFailures += 1;
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn("guvnah.sidecar.failed", { stage, error: msg });
    if (
      this.cfg.enabled &&
      !s.isOpen &&
      s.consecutiveFailures >= this.cfg.failure_threshold
    ) {
      s.isOpen = true;
      s.openUntil = Date.now() + this.cfg.cooldown_ms;
      logger.error("guvnah.breaker.open", {
        stage,
        cooldown_ms: this.cfg.cooldown_ms,
        consecutive_failures: s.consecutiveFailures,
      });
    }
  }

  async run<T>(stage: string, fn: () => Promise<T> | T, fallback: T): Promise<T> {
    if (this.isOpen(stage)) {
      return fallback;
    }
    try {
      const result = await fn();
      this.recordSuccess(stage);
      return result;
    } catch (err) {
      this.recordFailure(stage, err);
      return fallback;
    }
  }

  runSync<T>(stage: string, fn: () => T, fallback: T): T {
    if (this.isOpen(stage)) {
      return fallback;
    }
    try {
      const result = fn();
      this.recordSuccess(stage);
      return result;
    } catch (err) {
      this.recordFailure(stage, err);
      return fallback;
    }
  }
}
