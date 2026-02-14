export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

interface LogFields {
  [key: string]: unknown;
}

export function createLogger(component: string, level: LogLevel = "info") {
  function shouldLog(target: LogLevel): boolean {
    return LEVEL_ORDER[target] >= LEVEL_ORDER[level];
  }

  function write(target: LogLevel, event: string, fields: LogFields = {}): void {
    if (!shouldLog(target)) {
      return;
    }

    const payload = {
      ts: new Date().toISOString(),
      level: target,
      component,
      event,
      ...fields
    };

    console.log(JSON.stringify(payload));
  }

  return {
    debug: (event: string, fields?: LogFields) => write("debug", event, fields),
    info: (event: string, fields?: LogFields) => write("info", event, fields),
    warn: (event: string, fields?: LogFields) => write("warn", event, fields),
    error: (event: string, fields?: LogFields) => write("error", event, fields)
  };
}
