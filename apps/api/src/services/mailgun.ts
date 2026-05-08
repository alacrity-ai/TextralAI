// Mailgun service module.
//
// Single responsibility: dispatch one transactional email via Mailgun's
// `/v3/{domain}/messages` endpoint. Pattern mirrors home-app's
// services/mailgun.ts — short-circuit when credentials are absent so
// local dev needs no creds, fire-and-forget at the call site via
// `c.executionCtx.waitUntil(...)` so routes return 202 in <50 ms.
//
// Works on both runtimes: it's `fetch + FormData`, no CF-specific APIs.

import type { Env } from '../types.js';

export interface MailParams {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Mailgun `o:tag` for inbox filtering / analytics. Free-form. */
  tag?: string;
}

export interface MailResult {
  /** True when Mailgun accepted the message OR we short-circuited
   *  (credentials absent). False only on a genuine upstream error. */
  ok: boolean;
  /** Set when ok=false, for diagnostic logging. */
  status?: number;
  error?: string;
}

const DEFAULT_BASE_URL = 'https://api.mailgun.net';

export async function sendMail(env: Env, p: MailParams): Promise<MailResult> {
  const apiKey = env.MAILGUN_API_KEY;
  const domain = env.MAILGUN_DOMAIN;
  if (!apiKey || !domain) {
    // Short-circuit. Console.log goes through the redaction middleware
    // which strips bearer tokens / api keys / our own tx_live_ keys; we
    // also redact the recipient ourselves so the log doesn't surface
    // raw email addresses.
    console.log('[mailgun:short-circuit]', {
      to: redactEmail(p.to),
      subject: p.subject,
      tag: p.tag,
    });
    return { ok: true };
  }

  const baseUrl = env.MAILGUN_BASE_URL ?? DEFAULT_BASE_URL;
  const from = env.MAILGUN_FROM ?? `Textral <noreply@${domain}>`;

  const form = new FormData();
  form.set('from', from);
  form.set('to', p.to);
  form.set('subject', p.subject);
  form.set('text', p.text);
  form.set('html', p.html);
  if (p.tag) form.set('o:tag', p.tag);

  let res: Response;
  try {
    res = await fetch(`${stripTrailingSlash(baseUrl)}/v3/${domain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
      body: form,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[mailgun:network-error]', { error: msg, subject: p.subject });
    return { ok: false, error: msg };
  }

  if (!res.ok) {
    const body = await safeText(res);
    console.error('[mailgun:upstream-error]', {
      status: res.status,
      body: body.slice(0, 200),
      subject: p.subject,
    });
    return { ok: false, status: res.status, error: body };
  }

  return { ok: true };
}

// ── helpers ────────────────────────────────────────────────────────────

function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 1) return '[REDACTED]';
  return `${email[0]}***${email.slice(at)}`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
