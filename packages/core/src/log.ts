/**
 * One redacting structured logger (Protocol 02 §20, §11). Every log line passes through `redact`.
 * Secrets are masked by key name and by value pattern; the logger never throws.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string) => void;

const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|private[-_]?key|credential|dsn|database[-_]?url)/i;
const VALUE_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // provider keys (sk-..., sk-proj-..., sk-ant-...)
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS-style access key ids
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi, // DSN passwords
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
export const REDACTED = '[redacted]';

export function redactString(s: string): string {
  let out = s;
  for (const re of VALUE_PATTERNS) out = out.replace(re, (_m, a?: string, b?: string) => (a && b ? `${a}${REDACTED}${b}` : REDACTED));
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(opts: { sink: LogSink; level?: LogLevel; base?: Record<string, unknown>; now?: () => Date }): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const now = opts.now ?? (() => new Date());
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < min) return;
    try {
      opts.sink(JSON.stringify(redact({ ts: now().toISOString(), level, msg, ...opts.base, ...fields })));
    } catch {
      /* logging must never break the caller */
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...opts.base, ...fields } }),
  };
}

export const silentLogger: Logger = createLogger({ sink: () => {} });
