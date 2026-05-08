// /v1/auth/* client wrappers.
//
// These calls are PUBLIC — no `X-Textral-Api-Key` header. We can't
// reuse the `api()` helper from `client.ts` because it requires a
// stored key (it throws NO_KEY otherwise). Inline a minimal fetch +
// envelope-unwrap that mirrors `api()`'s error semantics.
//
// On non-2xx the call throws a `TextralApiError` (the same class
// `client.ts` exports), so call sites can branch on `.code` exactly
// like every other API call in the sandbox.
//
// `redeem` is the only call that returns a non-trivial body — the
// raw API key the sandbox immediately stuffs into localStorage.

import { TextralApiError, apiUrl } from './client.js';
import type {
  AuthOkResponse,
  RecoverRequest,
  RedeemRequest,
  RedeemResponse,
  RegisterRequest,
} from './types.js';

async function postPublic<TBody, TResponse>(
  path: string,
  body: TBody,
): Promise<TResponse> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return undefined as TResponse;
  const text = await res.text();
  if (!res.ok) {
    let parsed: { code: string; message: string; request_id?: string; details?: unknown } | null =
      null;
    if (text) {
      try {
        const obj = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; request_id?: unknown; details?: unknown } };
        if (obj.error && typeof obj.error.code === 'string' && typeof obj.error.message === 'string') {
          parsed = {
            code: obj.error.code,
            message: obj.error.message,
            ...(typeof obj.error.request_id === 'string' ? { request_id: obj.error.request_id } : {}),
            ...(obj.error.details !== undefined ? { details: obj.error.details } : {}),
          };
        }
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
  return text ? (JSON.parse(text) as TResponse) : (undefined as TResponse);
}

export function register(body: RegisterRequest): Promise<AuthOkResponse> {
  return postPublic<RegisterRequest, AuthOkResponse>('/v1/auth/register', body);
}

export function recover(body: RecoverRequest): Promise<AuthOkResponse> {
  return postPublic<RecoverRequest, AuthOkResponse>('/v1/auth/recover', body);
}

export function redeem(body: RedeemRequest): Promise<RedeemResponse> {
  return postPublic<RedeemRequest, RedeemResponse>('/v1/auth/redeem', body);
}
