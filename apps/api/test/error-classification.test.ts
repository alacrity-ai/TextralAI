import { describe, it, expect } from 'vitest';
import {
  classifyByStatus,
  classifyOpenAIError,
  classifyAnthropicError,
  isFatal,
  parseRetryAfter,
} from '../src/providers/error-classification.js';

describe('classifyByStatus', () => {
  it.each([
    [401, 'invalid_api_key'],
    [403, 'invalid_api_key'],
    [408, 'timeout'],
    [429, 'rate_limit'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'bad_request'],
    [404, 'bad_request'],
    [200, 'unknown'],
  ] as const)('status %d → %s', (status, expected) => {
    expect(classifyByStatus({ status, body: null, text: '' })).toBe(expected);
  });
});

describe('isFatal', () => {
  it('marks invalid_api_key, insufficient_quota, refusal, bad_request as fatal', () => {
    expect(isFatal('invalid_api_key')).toBe(true);
    expect(isFatal('insufficient_quota')).toBe(true);
    expect(isFatal('unsupported_model')).toBe(true);
    expect(isFatal('context_length_exceeded')).toBe(true);
    expect(isFatal('refusal')).toBe(true);
    expect(isFatal('bad_request')).toBe(true);
  });

  it('marks rate_limit, server_error, timeout, network, schema_violation as retryable', () => {
    expect(isFatal('rate_limit')).toBe(false);
    expect(isFatal('server_error')).toBe(false);
    expect(isFatal('timeout')).toBe(false);
    expect(isFatal('network')).toBe(false);
    expect(isFatal('schema_violation')).toBe(false);
    expect(isFatal('partial_batch')).toBe(false);
    expect(isFatal('malformed_response')).toBe(false);
    expect(isFatal('unknown')).toBe(false);
  });
});

describe('classifyOpenAIError', () => {
  it('classifies HTTP 429 with code insufficient_quota as fatal — v1 regression', () => {
    const r = classifyOpenAIError({
      status: 429,
      body: {
        error: { code: 'insufficient_quota', message: 'You exceeded your current quota...' },
      },
      text: '',
    });
    expect(r.type).toBe('insufficient_quota');
    expect(isFatal(r.type)).toBe(true);
    expect(r.upstream_code).toBe('insufficient_quota');
  });

  it('classifies HTTP 401 with code invalid_api_key as fatal', () => {
    const r = classifyOpenAIError({
      status: 401,
      body: { error: { code: 'invalid_api_key', message: 'Incorrect API key' } },
      text: '',
    });
    expect(r.type).toBe('invalid_api_key');
    expect(isFatal(r.type)).toBe(true);
  });

  it('classifies HTTP 401 with invalid_request_error + "API key" message as invalid_api_key', () => {
    const r = classifyOpenAIError({
      status: 401,
      body: {
        error: { code: 'invalid_request_error', message: 'No API key provided' },
      },
      text: '',
    });
    expect(r.type).toBe('invalid_api_key');
  });

  it('falls through to rate_limit on plain HTTP 429 with no code', () => {
    const r = classifyOpenAIError({
      status: 429,
      body: { error: { message: 'rate limit hit' } },
      text: '',
    });
    expect(r.type).toBe('rate_limit');
    expect(isFatal(r.type)).toBe(false);
  });

  it('classifies context_length_exceeded as fatal regardless of status', () => {
    const r = classifyOpenAIError({
      status: 400,
      body: { error: { code: 'context_length_exceeded', message: 'Too long' } },
      text: '',
    });
    expect(r.type).toBe('context_length_exceeded');
    expect(isFatal(r.type)).toBe(true);
  });

  it('classifies model_not_found as unsupported_model (fatal)', () => {
    const r = classifyOpenAIError({
      status: 404,
      body: { error: { code: 'model_not_found', message: 'no such model' } },
      text: '',
    });
    expect(r.type).toBe('unsupported_model');
    expect(isFatal(r.type)).toBe(true);
  });

  it('classifies HTTP 503 as server_error (retryable)', () => {
    const r = classifyOpenAIError({ status: 503, body: null, text: 'service unavailable' });
    expect(r.type).toBe('server_error');
    expect(isFatal(r.type)).toBe(false);
  });
});

describe('classifyAnthropicError', () => {
  it('maps authentication_error → invalid_api_key (fatal)', () => {
    const r = classifyAnthropicError({
      status: 401,
      body: { error: { type: 'authentication_error', message: 'auth failed' } },
      text: '',
    });
    expect(r.type).toBe('invalid_api_key');
    expect(isFatal(r.type)).toBe(true);
  });

  it('maps permission_error → invalid_api_key (fatal)', () => {
    const r = classifyAnthropicError({
      status: 403,
      body: { error: { type: 'permission_error', message: 'no perm' } },
      text: '',
    });
    expect(r.type).toBe('invalid_api_key');
  });

  it('maps rate_limit_error → rate_limit (retryable)', () => {
    const r = classifyAnthropicError({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'slow down' } },
      text: '',
    });
    expect(r.type).toBe('rate_limit');
    expect(isFatal(r.type)).toBe(false);
  });

  it('maps overloaded_error → server_error (retryable)', () => {
    const r = classifyAnthropicError({
      status: 529,
      body: { error: { type: 'overloaded_error', message: 'overloaded' } },
      text: '',
    });
    expect(r.type).toBe('server_error');
    expect(isFatal(r.type)).toBe(false);
  });

  it('maps request_too_large → context_length_exceeded (fatal)', () => {
    const r = classifyAnthropicError({
      status: 413,
      body: { error: { type: 'request_too_large', message: 'big' } },
      text: '',
    });
    expect(r.type).toBe('context_length_exceeded');
    expect(isFatal(r.type)).toBe(true);
  });

  it('maps invalid_request_error → bad_request', () => {
    const r = classifyAnthropicError({
      status: 400,
      body: { error: { type: 'invalid_request_error', message: 'bad' } },
      text: '',
    });
    expect(r.type).toBe('bad_request');
  });

  it('maps api_error → server_error', () => {
    const r = classifyAnthropicError({
      status: 500,
      body: { error: { type: 'api_error', message: 'internal' } },
      text: '',
    });
    expect(r.type).toBe('server_error');
  });

  it('maps not_found_error → unsupported_model (fatal)', () => {
    const r = classifyAnthropicError({
      status: 404,
      body: { error: { type: 'not_found_error', message: 'no model' } },
      text: '',
    });
    expect(r.type).toBe('unsupported_model');
    expect(isFatal(r.type)).toBe(true);
  });

  it('falls back to classifyByStatus when error.type is unknown', () => {
    const r = classifyAnthropicError({
      status: 503,
      body: { error: { type: 'mystery_error', message: '?' } },
      text: '',
    });
    expect(r.type).toBe('server_error');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds as ms', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });

  it('parses 0 as 0', () => {
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses an HTTP-date as ms-from-now (rounded down to >= 0)', () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(3000);
  });

  it('returns undefined for null / undefined / garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('not-a-number-not-a-date')).toBeUndefined();
  });
});
