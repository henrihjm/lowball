// Server-only helpers for the board's route handlers. The browser never talks to
// apps/api directly and never sees LOWBALL_API_TOKEN; these proxies attach it.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

type EnvMap = Record<string, string | undefined>;

let cached: { at: number; values: EnvMap } | undefined;

/** The repo root .env, parsed without touching process.env (it also holds the API's PORT and TZ). */
function rootEnv(): EnvMap {
  if (cached && Date.now() - cached.at < 10_000) return cached.values;
  let values: EnvMap = {};
  for (const file of [path.resolve(process.cwd(), '../../.env'), path.resolve(process.cwd(), '.env')]) {
    if (!existsSync(file)) continue;
    try {
      values = { ...values, ...parseEnv(readFileSync(file, 'utf8')) };
    } catch {
      // unreadable .env: fall through to process.env and defaults
    }
  }
  cached = { at: Date.now(), values };
  return values;
}

function clean(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  return v.startsWith('#') ? '' : v.replace(/\s+#.*$/, '').trim();
}

const read = (name: string): string => clean(process.env[name]) || clean(rootEnv()[name]);
const flag = (name: string): boolean => /^(1|true|yes|on)$/i.test(read(name));

export const apiBase = (): string => (read('LOWBALL_API_URL') || 'http://localhost:8787').replace(/\/+$/, '');

/** BOARD_MOCK=1 serves the built-in sample state instead of calling the API. */
export const mockMode = (): boolean => flag('BOARD_MOCK');

/** BOARD_READONLY=1 turns the operator chat off (panels only), for a board that is reachable by others. */
export const readOnly = (): boolean => flag('BOARD_READONLY');

/** Call apps/api with the shared token. `pathname` is always a fixed route, never caller-supplied text. */
export function apiFetch(pathname: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = read('LOWBALL_API_TOKEN');
  if (token) headers.set('x-lowball-token', token);
  return fetch(`${apiBase()}${pathname}`, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
}

export const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * A state-changing request must come from the board's own pages: JSON content type
 * (so a cross-site form post cannot reach it without a CORS preflight) and, when the
 * browser sends an Origin, the same host as the board.
 */
export function sameOriginJson(req: Request): boolean {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.get('host');
  } catch {
    return false;
  }
}

export const NO_STORE = { 'cache-control': 'no-store' } as const;
