import { redactForLedger, redactText } from './core/ledger.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Minimal structured logger: emits one JSON object per line so the bot's
 * output can be piped into any log aggregator.
 */
export class Logger {
  private readonly sink: (record: LogRecord) => void;
  private readonly minLevel: number;

  constructor(opts: { sink?: (record: LogRecord) => void; level?: LogLevel } = {}) {
    this.sink = opts.sink ?? ((record) => console.log(JSON.stringify(record)));
    this.minLevel = LEVEL_ORDER[opts.level ?? 'info'];
  }

  private log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    this.sink({
      ts: new Date().toISOString(),
      level,
      msg: redactText(msg),
      ...(redactForLedger(fields) as Record<string, unknown>),
    });
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }
}
