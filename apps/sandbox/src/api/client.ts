// Slim fetch wrapper. Reads the API key from localStorage on every call —
// no React-state coupling, so background timers and SSE consumers can use
// it. The {error: {...}} envelope is unwrapped into TextralApiError so call
// sites just `try/catch` without juggling response shapes.

import { z } from 'zod';

// Build-time API origin. Empty string preserves relative-URL behavior so
// vite-dev (proxy) and self-host (nginx) deploys keep working unchanged.
// On Cloudflare Pages, set this at build time to the Worker's URL.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '') as string;

export function apiUrl(path: string): string {
  return /^https?:\/\//i.test(path) ? path : `${API_BASE}${path}`;
}

const TextralErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    request_id: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export class TextralApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TextralApiError';
  }
}

export function getStoredKey(): string | null {
  return localStorage.getItem('textral_api_key');
}

function requireKey(): string {
  const k = getStoredKey();
  if (!k) {
    throw new TextralApiError(0, 'NO_KEY', 'API key missing — gate should have prevented this');
  }
  return k;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

export async function api<T = unknown>(
  method: Method,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    'x-textral-api-key': requireKey(),
    accept: 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers['content-type'] = 'application/json';
  }
  // ...init must come BEFORE our overrides so init.headers doesn't
  // clobber the merged headers (which carry the api key).
  const res = await fetch(apiUrl(path), {
    ...init,
    method,
    headers,
    body:
      body === undefined
        ? null
        : body instanceof FormData || body instanceof Blob
          ? body
          : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let parsed: {
      code: string;
      message: string;
      request_id?: string | undefined;
      details?: unknown;
    } | null = null;
    if (text) {
      try {
        const obj = JSON.parse(text);
        const result = TextralErrorSchema.safeParse(obj);
        if (result.success) parsed = result.data.error;
      } catch {
        // fall through
      }
    }
    if (parsed) {
      throw new TextralApiError(
        res.status,
        parsed.code,
        parsed.message,
        parsed.request_id,
        parsed.details,
      );
    }
    throw new TextralApiError(res.status, 'UNKNOWN', text || `HTTP ${res.status}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// Make a raw fetch with the api key header attached. Used for streaming
// SSE responses and any non-JSON download paths.
export async function apiRaw(
  method: Method,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-textral-api-key': requireKey(),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Blob)) {
    headers['content-type'] = 'application/json';
  }
  // ...init must come BEFORE our overrides so init.headers doesn't
  // clobber the merged headers (which carry the api key).
  return fetch(apiUrl(path), {
    ...init,
    method,
    headers,
    body:
      body === undefined
        ? null
        : body instanceof FormData || body instanceof Blob
          ? body
          : JSON.stringify(body),
  });
}
