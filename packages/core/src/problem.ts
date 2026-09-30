/** RFC 9457 problem details with stable machine codes (ADR-0004). Never carries stack traces or secrets. */
export const PROBLEM_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'BUDGET_EXCEEDED',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'LIVE_TRADING_DISABLED',
  'SAMPLE_ONLY',
  'KILL_SWITCH_ENGAGED',
  'UNSUPPORTED',
  'INTERNAL',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

const STATUS: Record<ProblemCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  APPROVAL_REQUIRED: 202,
  APPROVAL_INVALID: 409,
  BUDGET_EXCEEDED: 402,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  LIVE_TRADING_DISABLED: 403,
  SAMPLE_ONLY: 409,
  KILL_SWITCH_ENGAGED: 423,
  UNSUPPORTED: 501,
  INTERNAL: 500,
};

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail?: string;
  readonly instance?: string;
  /** Safe structured extras (field errors, approval id, retry-after). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export class XyraError extends Error {
  readonly code: ProblemCode;
  readonly extra: Readonly<Record<string, unknown>> | undefined;
  constructor(code: ProblemCode, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'XyraError';
    this.code = code;
    this.extra = extra;
  }
}

export const statusFor = (code: ProblemCode): number => STATUS[code];

export function toProblem(err: unknown, instance?: string): Problem {
  if (err instanceof XyraError) {
    return {
      type: `urn:xyra:problem:${err.code.toLowerCase()}`,
      title: err.code.replace(/_/g, ' ').toLowerCase(),
      status: STATUS[err.code],
      code: err.code,
      detail: err.message,
      ...(instance ? { instance } : {}),
      ...(err.extra ? { extra: err.extra } : {}),
    };
  }
  return {
    type: 'urn:xyra:problem:internal',
    title: 'internal error',
    status: 500,
    code: 'INTERNAL',
    detail: 'An unexpected error occurred. See the diagnostics log for the correlation id.',
    ...(instance ? { instance } : {}),
  };
}

export const isProblem = (v: unknown): v is Problem =>
  typeof v === 'object' && v !== null && 'code' in v && 'status' in v && typeof (v as Problem).code === 'string';
