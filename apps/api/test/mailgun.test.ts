import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendMail } from '../src/services/mailgun.js';
import type { Env } from '../src/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendMail — short-circuit', () => {
  it('returns ok=true and never calls fetch when MAILGUN_API_KEY is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = { MAILGUN_DOMAIN: 'mg.example.com' } as Env;

    const res = await sendMail(env, {
      to: 'someone@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });

    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns ok=true and never calls fetch when MAILGUN_DOMAIN is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = { MAILGUN_API_KEY: 'k' } as Env;

    const res = await sendMail(env, {
      to: 'someone@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });

    expect(res.ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sendMail — wire path', () => {
  function envWith(overrides?: Partial<Env>): Env {
    return {
      MAILGUN_API_KEY: 'mg-key-test',
      MAILGUN_DOMAIN: 'mg.example.com',
      ...overrides,
    } as Env;
  }

  it('POSTs to https://api.mailgun.net/v3/{domain}/messages with Basic auth', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }) as Response);

    const res = await sendMail(envWith(), {
      to: 'a@example.com',
      subject: 'subj',
      text: 'hello',
      html: '<p>hello</p>',
      tag: 'register',
    });

    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.mailgun.net/v3/mg.example.com/messages');
    expect((init as RequestInit).method).toBe('POST');
    const auth = (init as RequestInit).headers as Record<string, string>;
    expect(auth.Authorization).toBe(`Basic ${btoa('api:mg-key-test')}`);
    const body = (init as RequestInit).body as FormData;
    expect(body.get('to')).toBe('a@example.com');
    expect(body.get('subject')).toBe('subj');
    expect(body.get('text')).toBe('hello');
    expect(body.get('html')).toBe('<p>hello</p>');
    expect(body.get('o:tag')).toBe('register');
    expect(body.get('from')).toBe('Textral <noreply@mg.example.com>');
  });

  it('honors MAILGUN_FROM override', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }) as Response);
    await sendMail(envWith({ MAILGUN_FROM: 'Textral Custom <hi@example.com>' }), {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });
    const body = (fetchSpy.mock.calls[0]![1] as RequestInit).body as FormData;
    expect(body.get('from')).toBe('Textral Custom <hi@example.com>');
  });

  it('honors MAILGUN_BASE_URL override and strips trailing slash', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }) as Response);
    await sendMail(envWith({ MAILGUN_BASE_URL: 'https://api.eu.mailgun.net/' }), {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });
    const url = fetchSpy.mock.calls[0]![0];
    expect(url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
  });

  it('returns ok=false (no throw) on a 4xx upstream response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('domain not allowed', { status: 401 }) as Response,
    );
    const res = await sendMail(envWith(), {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
  });

  it('returns ok=false (no throw) when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('econnrefused'));
    const res = await sendMail(envWith(), {
      to: 'a@example.com',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/econnrefused/);
  });
});
