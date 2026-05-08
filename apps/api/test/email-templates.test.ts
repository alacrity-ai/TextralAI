import { describe, it, expect } from 'vitest';
import { renderRecoverEmail, renderRegisterEmail } from '../src/services/email-templates.js';

describe('renderRegisterEmail', () => {
  const opts = {
    redeemUrl: 'https://textral.example.com/redeem/abc123',
    displayName: 'Acme RAG',
  };

  it('uses the canonical subject', () => {
    const m = renderRegisterEmail(opts);
    expect(m.subject).toBe('Confirm your Textral tenant');
  });

  it('tags the message for Mailgun analytics', () => {
    expect(renderRegisterEmail(opts).tag).toBe('auth-register');
  });

  it('includes the redeem URL in both text and HTML', () => {
    const m = renderRegisterEmail(opts);
    expect(m.text).toContain(opts.redeemUrl);
    expect(m.html).toContain(opts.redeemUrl);
  });

  it('includes the display name in the body copy', () => {
    const m = renderRegisterEmail(opts);
    expect(m.text).toContain('Acme RAG');
    expect(m.html).toContain('Acme RAG');
  });

  it('includes the 1-hour expiry note in both renderings', () => {
    const m = renderRegisterEmail(opts);
    expect(m.text.toLowerCase()).toContain('1 hour');
    expect(m.html.toLowerCase()).toContain('1 hour');
  });

  it('escapes HTML-unsafe characters in the display name', () => {
    const m = renderRegisterEmail({
      redeemUrl: 'https://x/',
      displayName: '<script>alert(1)</script>',
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('escapes HTML-unsafe characters in the redeem URL', () => {
    const m = renderRegisterEmail({
      redeemUrl: 'https://x/?a="&b=<x>',
      displayName: 'Acme',
    });
    expect(m.html).not.toContain('a="&b=<x>');
    expect(m.html).toContain('a=&quot;');
  });
});

describe('renderRecoverEmail', () => {
  const opts = { redeemUrl: 'https://textral.example.com/redeem/xyz' };

  it('uses the canonical subject', () => {
    expect(renderRecoverEmail(opts).subject).toBe('Recover your Textral API key');
  });

  it('tags the message for Mailgun analytics', () => {
    expect(renderRecoverEmail(opts).tag).toBe('auth-recover');
  });

  it('includes the redeem URL in both text and HTML', () => {
    const m = renderRecoverEmail(opts);
    expect(m.text).toContain(opts.redeemUrl);
    expect(m.html).toContain(opts.redeemUrl);
  });

  it('does not reference any display name (recover has no displayName)', () => {
    // Sanity: ensure we didn't accidentally leak `${undefined}` etc.
    const m = renderRecoverEmail(opts);
    expect(m.text).not.toContain('undefined');
    expect(m.html).not.toContain('undefined');
  });
});

describe('email templates — shared shape', () => {
  it('produces a `to` field that the caller fills (kept empty here)', () => {
    expect(renderRegisterEmail({ redeemUrl: 'x', displayName: 'y' }).to).toBe('');
    expect(renderRecoverEmail({ redeemUrl: 'x' }).to).toBe('');
  });

  it('produces non-empty text and html bodies', () => {
    const a = renderRegisterEmail({ redeemUrl: 'x', displayName: 'y' });
    const b = renderRecoverEmail({ redeemUrl: 'x' });
    expect(a.text.length).toBeGreaterThan(50);
    expect(a.html.length).toBeGreaterThan(200);
    expect(b.text.length).toBeGreaterThan(50);
    expect(b.html.length).toBeGreaterThan(200);
  });
});
