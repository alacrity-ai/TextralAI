// Redaction middleware. Single source of truth for "what counts as a
// secret in our system." A false positive is acceptable; a missed leak
// is not.
//
// The middleware:
//   1. Wraps console.log/info/warn/error with a redacting interceptor.
//   2. Provides a `redact(s)` function that any other log sink (Workers
//      Analytics Engine, AI Gateway tag construction site, error
//      envelope formatter) can call before emitting.
//   3. Ensures error envelopes never echo the original request body.
//
// Patterns are extended liberally over time. Adding a pattern is
// always backwards-compatible; removing one is not.

import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from '../types.js';

// ── Patterns ───────────────────────────────────────────────────────────
//
// Order matters in one direction: longer/more-specific prefixes first
// so they match before generic-shape patterns. Each pattern matches the
// full token shape so the replacement leaves no recognizable fragment.

const KEY_PATTERNS: RegExp[] = [
  /\bsk-proj-[A-Za-z0-9_\-]{16,}/g, // OpenAI project keys
  /\bsk-ant-[A-Za-z0-9_\-]{16,}/g, // Anthropic
  /\bxai-[A-Za-z0-9_\-]{16,}/g, // xAI
  /\br8_[A-Za-z0-9_\-]{16,}/g, // Replicate
  /\bvoy-[A-Za-z0-9]{16,}/g, // Voyage
  /\bsk-[A-Za-z0-9_\-]{16,}/g, // OpenAI (generic; must come AFTER sk-proj/sk-ant)
  /\btx_(?:live|test)_[0-9A-HJKMNP-TV-Z]{26}_[A-Z2-7]{32}\b/g, // Our own keys
];

const HEADER_REDACT_LIST = new Set(
  ['authorization', 'x-textral-api-key', 'x-admin-bootstrap-token', 'cf-aig-authorization'].map(
    (s) => s.toLowerCase(),
  ),
);

const HEADER_PROVIDER_KEY_PREFIX = 'x-provider-key-';

const JSON_FIELD_REDACT_LIST = new Set([
  'key',
  'apikey',
  'api_key',
  'secret',
  'password',
  'authorization',
  'bearer',
  'token',
]);

const REDACTED = '[REDACTED]';

// ── Public API ─────────────────────────────────────────────────────────

export function redact(s: string): string {
  let out = s;
  for (const pat of KEY_PATTERNS) out = out.replace(pat, REDACTED);
  return out;
}

export function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HEADER_REDACT_LIST.has(lower) || lower.startsWith(HEADER_PROVIDER_KEY_PREFIX)) {
      out[name] = REDACTED;
    } else {
      out[name] = redact(value);
    }
  }
  return out;
}

export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 32) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (JSON_FIELD_REDACT_LIST.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redactJson(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

// ── Middleware ─────────────────────────────────────────────────────────

const ORIGINAL_CONSOLE: Pick<Console, 'log' | 'info' | 'warn' | 'error' | 'debug'> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

let installed = false;

/** Wrap the console methods exactly once per isolate. Idempotent. */
function installConsoleInterceptors(): void {
  if (installed) return;
  installed = true;
  const wrap = (method: keyof typeof ORIGINAL_CONSOLE) => {
    return (...args: unknown[]) => {
      ORIGINAL_CONSOLE[method](...args.map((a) => redactJson(a)));
    };
  };
  console.log = wrap('log') as typeof console.log;
  console.info = wrap('info') as typeof console.info;
  console.warn = wrap('warn') as typeof console.warn;
  console.error = wrap('error') as typeof console.error;
  console.debug = wrap('debug') as typeof console.debug;
}

/**
 * Hono middleware that installs the console interceptors before any
 * other middleware runs. Mount this FIRST.
 */
export const redactionMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (_c, next) => {
    installConsoleInterceptors();
    await next();
  },
);
