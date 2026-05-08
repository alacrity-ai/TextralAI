// Transactional email templates for tenant registration + key recovery.
//
// Two renderers, one shape: each returns the `MailParams` the Mailgun
// service expects. HTML uses inline styles only — most webmail clients
// strip <style> blocks. Plain-text body is included for deliverability
// (Mailgun scoring rewards it) and for clients that disable HTML.
//
// Aesthetic: matches the sandbox's Newsreader/IBM-Plex pairing where it
// can. We assume the user's mail client may not have those fonts, so we
// fall back through serif → system. The single CTA is a black-on-white
// button with a 1px rule above for editorial feel.

import type { MailParams } from './mailgun.js';

export interface RegisterEmailOpts {
  /** Full URL the CTA button links to (e.g. https://...redeem/<token>). */
  redeemUrl: string;
  /** Display name the user supplied at /v1/auth/register. Goes into the
   *  body copy ("Your tenant <displayName> is ready to confirm"). */
  displayName: string;
}

export interface RecoverEmailOpts {
  redeemUrl: string;
}

const SIGNATURE = 'The Textral team';

export function renderRegisterEmail(opts: RegisterEmailOpts): MailParams {
  const subject = 'Confirm your Textral tenant';
  const heading = 'Confirm your tenant';
  const intro =
    `We received a request to create a Textral tenant for ${opts.displayName}. ` +
    `Click the button below within the next hour to mint your tenant and ` +
    `your first API key.`;
  return {
    to: '', // filled by caller
    subject,
    text: renderText({ heading, intro, ctaLabel: 'Confirm tenant', ctaUrl: opts.redeemUrl }),
    html: renderHtml({ heading, intro, ctaLabel: 'Confirm tenant', ctaUrl: opts.redeemUrl }),
    tag: 'auth-register',
  };
}

export function renderRecoverEmail(opts: RecoverEmailOpts): MailParams {
  const subject = 'Recover your Textral API key';
  const heading = 'Recover your API key';
  const intro =
    `We received a request to mint a fresh API key for the Textral tenant ` +
    `attached to this email. Click the button below within the next hour.`;
  return {
    to: '',
    subject,
    text: renderText({ heading, intro, ctaLabel: 'Mint a new API key', ctaUrl: opts.redeemUrl }),
    html: renderHtml({ heading, intro, ctaLabel: 'Mint a new API key', ctaUrl: opts.redeemUrl }),
    tag: 'auth-recover',
  };
}

// ── shared template scaffolding ────────────────────────────────────────

interface Block {
  heading: string;
  intro: string;
  ctaLabel: string;
  ctaUrl: string;
}

function renderText(b: Block): string {
  return [
    'TEXTRAL',
    '',
    b.heading,
    '─'.repeat(b.heading.length),
    '',
    b.intro,
    '',
    `${b.ctaLabel}: ${b.ctaUrl}`,
    '',
    'This link expires in 1 hour.',
    "If you didn't request this, you can safely ignore this email.",
    '',
    `— ${SIGNATURE}`,
  ].join('\n');
}

function renderHtml(b: Block): string {
  // Inline styles only. Tested in Gmail + Outlook.com.
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escape(b.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Georgia,'Times New Roman',serif;color:#1f1c19;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f4f1ec;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border:1px solid #e3ddd2;max-width:560px;width:100%;">
        <tr><td style="padding:36px 40px 8px 40px;">
          <div style="font-family:'IBM Plex Mono',Menlo,Consolas,monospace;font-size:11px;letter-spacing:0.30em;text-transform:uppercase;color:#7a4a18;">
            Textral · Sandbox
          </div>
        </td></tr>
        <tr><td style="padding:0 40px 8px 40px;">
          <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-weight:400;font-size:30px;letter-spacing:-0.015em;color:#1f1c19;">
            ${escape(b.heading)}
          </h1>
        </td></tr>
        <tr><td style="padding:0 40px;">
          <hr style="border:0;border-top:1px solid #e3ddd2;margin:14px 0;">
        </td></tr>
        <tr><td style="padding:8px 40px 24px 40px;font-size:15px;line-height:1.6;color:#3a342d;">
          <p style="margin:0 0 24px 0;">${escape(b.intro)}</p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
            <tr><td>
              <a href="${escapeAttr(b.ctaUrl)}"
                 style="display:inline-block;background:#1f1c19;color:#f7f3ec;text-decoration:none;padding:12px 22px;font-family:'IBM Plex Mono',Menlo,Consolas,monospace;font-size:13px;letter-spacing:0.05em;border-radius:2px;">
                ${escape(b.ctaLabel)}
              </a>
            </td></tr>
          </table>
          <p style="margin:24px 0 0 0;font-size:13px;color:#7a716a;font-style:italic;">
            This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
          </p>
        </td></tr>
        <tr><td style="padding:0 40px 32px 40px;">
          <hr style="border:0;border-top:1px solid #e3ddd2;margin:14px 0;">
          <div style="font-family:'IBM Plex Mono',Menlo,Consolas,monospace;font-size:11px;color:#7a716a;letter-spacing:0.05em;">
            — ${escape(SIGNATURE)}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escape(s);
}
