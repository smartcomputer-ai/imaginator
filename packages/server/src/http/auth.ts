import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { AuthConfig } from '../config.js';

export const SESSION_COOKIE = 'imaginator_session';

export type Principal = 'session' | 'apiKey';

export interface Auth {
  /** Who sent this request, or undefined when it carries no valid credential. */
  authenticate(req: Request): Principal | undefined;
  /** Constant-time password check. */
  checkPassword(password: string): boolean;
  /** Mint a session token; `exp` is its expiry (ms epoch). */
  issueSession(now?: number): { token: string; exp: number };
  /** `Set-Cookie` value for a fresh session. */
  sessionCookie(token: string, exp: number, secure: boolean): string;
  /** `Set-Cookie` value that clears the session. */
  clearCookie(secure: boolean): string;
  /** Delay to impose on a failed login (grows with consecutive failures, resets on success). */
  loginFailed(): number;
  loginSucceeded(): void;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** Compare two strings in constant time regardless of length (hash both first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * Stateless sessions: the token is `<exp>.<hmac(exp)>` signed with a key
 * derived from the configured secrets, so sessions survive a restart and
 * every session dies when the password or API key changes.
 */
export function createAuth(config: AuthConfig): Auth {
  const secret = createHash('sha256').update(`imaginator-session\n${config.password}\n${config.apiKey}`).digest();
  const sign = (exp: number) => b64url(createHmac('sha256', secret).update(`session:${exp}`).digest());
  let failures = 0;
  let lastFailure = 0;

  function verifySession(token: string | undefined, now: number): boolean {
    if (!token) return false;
    const dot = token.indexOf('.');
    if (dot < 0) return false;
    const exp = Number(token.slice(0, dot));
    if (!Number.isFinite(exp) || exp <= now) return false;
    return safeEqual(token.slice(dot + 1), sign(exp));
  }

  const cookieAttrs = (secure: boolean) => `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

  return {
    authenticate(req) {
      const authz = req.headers.get('authorization');
      if (authz) {
        const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
        if (m && safeEqual(m[1]!.trim(), config.apiKey)) return 'apiKey';
      }
      if (verifySession(readCookie(req.headers.get('cookie'), SESSION_COOKIE), Date.now())) return 'session';
      return undefined;
    },
    checkPassword: (password) => safeEqual(password, config.password),
    issueSession(now = Date.now()) {
      const exp = now + config.sessionTtlMs;
      return { token: `${exp}.${sign(exp)}`, exp };
    },
    sessionCookie: (token, exp, secure) => `${SESSION_COOKIE}=${token}; ${cookieAttrs(secure)}; Expires=${new Date(exp).toUTCString()}`,
    clearCookie: (secure) => `${SESSION_COOKIE}=; ${cookieAttrs(secure)}; Max-Age=0`,
    loginFailed() {
      const now = Date.now();
      if (now - lastFailure > 15 * 60 * 1000) failures = 0;
      failures++;
      lastFailure = now;
      return Math.min(250 * 2 ** (failures - 1), 5000);
    },
    loginSucceeded() {
      failures = 0;
    },
  };
}
