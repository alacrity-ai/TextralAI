import { describe, it, expect } from 'vitest';
import { gatewayBaseUrl, buildAigMetadata } from '../src/providers/ai-gateway.js';

describe('gatewayBaseUrl', () => {
  it('appends the provider segment to the runtime-supplied base URL (CF shape)', () => {
    expect(
      gatewayBaseUrl({
        base_url: 'https://gateway.ai.cloudflare.com/v1/acct/textral-dev',
        metadata_header_prefix: 'cf-aig-',
        provider: 'openai',
      }),
    ).toBe('https://gateway.ai.cloudflare.com/v1/acct/textral-dev/openai');
  });

  it('appends the provider segment to a Node-runtime AIG-compatible proxy URL', () => {
    expect(
      gatewayBaseUrl({
        base_url: 'https://aig.tenant.com',
        metadata_header_prefix: 'x-aig-',
        provider: 'anthropic',
      }),
    ).toBe('https://aig.tenant.com/anthropic');
  });
});

describe('buildAigMetadata', () => {
  it('forwards allowlisted string keys', () => {
    expect(buildAigMetadata({ tenant_id: 'ten_x', namespace_id: 'ns_y' })).toBe(
      '{"tenant_id":"ten_x","namespace_id":"ns_y"}',
    );
  });

  it('drops non-allowlisted keys', () => {
    expect(buildAigMetadata({ tenant_id: 'ten_x', secret: 'shhh' })).toBe('{"tenant_id":"ten_x"}');
  });

  it('coerces numbers and booleans to strings', () => {
    const out = JSON.parse(buildAigMetadata({ tenant_id: 42, request_id: true, debug: false }));
    expect(out).toEqual({ tenant_id: '42', request_id: 'true' });
  });

  it('drops null / undefined values', () => {
    expect(buildAigMetadata({ tenant_id: 'ten', namespace_id: null })).toBe('{"tenant_id":"ten"}');
  });

  it('returns {} when no keys are allowlisted', () => {
    expect(buildAigMetadata({ secret: 'x', api_key: 'y' })).toBe('{}');
  });
});
