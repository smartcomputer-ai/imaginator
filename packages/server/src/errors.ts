export type ErrorCode = 'validation' | 'not_found' | 'conflict' | 'storage' | 'internal' | 'unauthorized';

const STATUS: Record<ErrorCode, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  storage: 500,
  internal: 500,
  unauthorized: 401,
};

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly issues: unknown[] | undefined;
  constructor(code: ErrorCode, message: string, issues?: unknown[]) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = STATUS[code];
    this.issues = issues;
  }
}

export const notFound = (what: string) => new ServiceError('not_found', `${what} not found`);
export const conflict = (message: string) => new ServiceError('conflict', message);
export const invalid = (message: string, issues?: unknown[]) => new ServiceError('validation', message, issues);
