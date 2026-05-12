type Level = "info" | "warn" | "error" | "debug";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.GUVNAH_DEBUG) emit("debug", msg, fields);
  },
};
