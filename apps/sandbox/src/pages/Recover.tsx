// /recover — request a key-recovery email.
//
// Single-field form (email). On submit we POST to /v1/auth/recover and
// always swap to the same success state regardless of whether the
// email is registered — the backend already enforces the no-leak
// contract; the UI mirrors it.

import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { TextralApiError } from '../api/client.js';
import { recover } from '../api/auth.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

type Phase = 'form' | 'sent';

export function Recover() {
  const [phase, setPhase] = useState<Phase>('form');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await recover({ email: email.trim() });
      setPhase('sent');
    } catch (e) {
      if (e instanceof TextralApiError) {
        if (e.code === 'RATE_LIMITED') {
          setErr('Too many recovery attempts. Wait one minute and try again.');
        } else if (e.code === 'TENANT_REGISTRATION_DISABLED') {
          setErr(
            'Self-service recovery is not configured on this deploy. Ask the operator to set Mailgun credentials.',
          );
        } else if (e.code === 'BAD_REQUEST') {
          setErr('Check the email address and try again.');
        } else {
          setErr(e.message);
        }
      } else {
        setErr(`Network error: ${(e as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = email.includes('@') && !busy;

  return (
    <div style={pageBackdrop}>
      <div style={{ width: 'min(560px, 92vw)' }}>
        <Card ruled style={{ padding: '40px 36px' }}>
          <Eyebrow />
          {phase === 'form' ? (
            <>
              <h1 style={headerTitle}>Recover your API key</h1>
              <p style={subtitle}>
                Enter the email tied to your Textral tenant. If we find a match, we'll send you a
                link that mints a fresh API key.
              </p>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) void submit();
                }}
                placeholder="you@example.com"
                autoFocus
                label="Email"
                autoComplete="email"
                {...(err ? { error: err } : {})}
              />
              <div
                style={{
                  marginTop: spacing.md,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: spacing.md,
                }}
              >
                <Link to="/" style={inlineLinkStyle}>
                  Back to sign in
                </Link>
                <Button onClick={submit} disabled={!canSubmit} loading={busy}>
                  {busy ? 'Sending' : 'Send recovery email'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <h1 style={headerTitle}>Check your email</h1>
              <p style={subtitle}>
                If a Textral tenant exists for{' '}
                <span style={{ color: colors.accent, fontStyle: 'normal', fontFamily: fonts.mono }}>
                  {email.trim()}
                </span>
                , a recovery link is on its way. The link expires in 1 hour.
              </p>
              <div style={infoCallout}>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: colors.textSecondary, fontFamily: fonts.serif }}>
                  Didn't get it? Check your spam folder, or{' '}
                  <button onClick={() => setPhase('form')} style={inlineButtonStyle}>
                    try a different email
                  </button>
                  .
                </p>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  marginTop: spacing.lg,
                }}
              >
                <Link to="/">
                  <Button variant="secondary">Back to sign in</Button>
                </Link>
              </div>
            </>
          )}

          <hr className="rule" style={{ margin: `${spacing.lg}px 0 ${spacing.md}px 0` }} />

          <div
            style={{
              fontSize: 12,
              color: colors.textMuted,
              fontFamily: fonts.serif,
              fontStyle: 'italic',
              lineHeight: 1.6,
            }}
          >
            For security, the response is the same whether or not the email is registered.
          </div>
        </Card>
      </div>
    </div>
  );
}

function Eyebrow() {
  return (
    <div
      aria-hidden
      style={{
        fontFamily: fonts.sans,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.30em',
        textTransform: 'uppercase',
        color: colors.primary,
        marginBottom: 8,
      }}
    >
      Textral · Sandbox
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────

const pageBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(13, 11, 9, 0.85)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  zIndex: 999,
};

const headerTitle: CSSProperties = {
  margin: 0,
  fontFamily: fonts.display,
  fontWeight: 400,
  fontSize: 36,
  letterSpacing: '-0.025em',
  color: colors.textPrimary,
  fontVariationSettings: '"opsz" 144, "SOFT" 30',
  marginBottom: spacing.sm,
};

const subtitle: CSSProperties = {
  margin: 0,
  marginBottom: spacing.lg,
  fontSize: 14,
  color: colors.textSecondary,
  fontFamily: fonts.serif,
  fontStyle: 'italic',
  lineHeight: 1.55,
};

const infoCallout: CSSProperties = {
  background: colors.bgElevated,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: '14px 18px',
};

const inlineLinkStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: fonts.serif,
  fontStyle: 'italic',
  color: colors.textMuted,
  textDecoration: 'underline',
  textDecorationColor: colors.borderEmphasis,
  textUnderlineOffset: 3,
};

const inlineButtonStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  color: colors.accent,
  fontFamily: 'inherit',
  fontStyle: 'inherit',
  fontSize: 'inherit',
  textDecoration: 'underline',
  cursor: 'pointer',
};
