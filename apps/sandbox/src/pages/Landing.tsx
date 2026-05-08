// Public landing page. Renders inside ApiKeyGate when no API key is set.
//
// Two tabs: Sign in (paste an existing API key) and Register (request
// a confirmation email to mint a fresh tenant). Sign in is the default
// because returning users hit it more often than first-time visitors.
//
// After a successful register, the Register tab swaps to a "check your
// email" panel — same shell, new content. We do NOT route away from /
// because the user might come back to switch tabs (e.g. paste a key
// while waiting for the email).

import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useApiKey } from '../auth/ApiKeyContext.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { TextralApiError, apiUrl } from '../api/client.js';
import { register } from '../api/auth.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

type Tab = 'signin' | 'register';
type RegisterPhase = 'form' | 'sent';

export function Landing() {
  const [tab, setTab] = useState<Tab>('signin');

  return (
    <div style={pageBackdrop}>
      <div style={{ width: 'min(560px, 92vw)' }}>
        <Card ruled style={{ padding: '40px 36px' }}>
          <Eyebrow />
          <h1 style={headerTitle}>
            {tab === 'signin' ? 'Sign in' : 'Register a tenant'}
          </h1>
          <p style={subtitle}>
            {tab === 'signin'
              ? 'Paste your API key to continue, or register a new tenant via email.'
              : "We'll email you a confirmation link. Click it to mint your tenant and your first API key."}
          </p>

          <Tabs tab={tab} onChange={setTab} />

          <div style={{ marginTop: spacing.lg }}>
            {tab === 'signin' ? <SignInPanel /> : <RegisterPanel />}
          </div>

          <hr className="rule" style={{ margin: `${spacing.lg}px 0` }} />

          <FooterHelp />
        </Card>
      </div>
    </div>
  );
}

// ── Sign in tab ────────────────────────────────────────────────────────

function SignInPanel() {
  const { setKey } = useApiKey();
  const [pending, setPending] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!pending.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      // Validate the pasted key against /v1/me — same probe the
      // pre-Phase-C gate did. If it 401s, surface a clear error
      // instead of stuffing a bad key into localStorage.
      const res = await fetch(apiUrl('/v1/me'), {
        headers: { 'x-textral-api-key': pending.trim() },
      });
      if (!res.ok) {
        if (res.status === 401) {
          setErr('Invalid API key — the server returned 401 Unauthorized.');
        } else if (res.status === 404) {
          setErr('Tenant not found for this key.');
        } else {
          setErr(`Server returned ${res.status}.`);
        }
        return;
      }
      setKey(pending.trim());
    } catch (e) {
      setErr(`Network error: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Input
        type="password"
        value={pending}
        onChange={(e) => setPending(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        placeholder="tx_live_..."
        autoFocus
        {...(err ? { error: err } : {})}
        label="Textral API key"
      />
      <div style={{ marginTop: spacing.md, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md }}>
        <Link to="/recover" style={forgotLinkStyle}>
          Forgot your key?
        </Link>
        <Button onClick={submit} disabled={!pending.trim() || busy} loading={busy}>
          {busy ? 'Validating' : 'Continue'}
        </Button>
      </div>
    </>
  );
}

// ── Register tab ───────────────────────────────────────────────────────

function RegisterPanel() {
  const [phase, setPhase] = useState<RegisterPhase>('form');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await register({ email: email.trim(), display_name: displayName.trim() });
      setPhase('sent');
    } catch (e) {
      if (e instanceof TextralApiError) {
        if (e.code === 'RATE_LIMITED') {
          setErr('Too many register attempts. Wait one minute and try again.');
        } else if (e.code === 'TENANT_REGISTRATION_DISABLED') {
          setErr(
            'Self-service registration is not configured on this deploy. Ask the operator to set Mailgun credentials, or use /v1/admin/bootstrap.',
          );
        } else if (e.code === 'BAD_REQUEST') {
          setErr('Check the email and tenant name and try again.');
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

  if (phase === 'sent') {
    return <CheckYourEmail email={email.trim()} onResend={() => setPhase('form')} />;
  }

  const canSubmit = email.includes('@') && displayName.trim().length >= 2 && !busy;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.md }}>
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        autoFocus
        label="Email"
        autoComplete="email"
      />
      <Input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && canSubmit) void submit();
        }}
        placeholder="Acme RAG"
        label="Tenant name"
        {...(err ? { error: err } : {})}
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: spacing.xs }}>
        <Button onClick={submit} disabled={!canSubmit} loading={busy}>
          {busy ? 'Sending' : 'Send confirmation email'}
        </Button>
      </div>
    </div>
  );
}

function CheckYourEmail({ email, onResend }: { email: string; onResend: () => void }) {
  return (
    <div style={{ textAlign: 'left' }}>
      <div style={emailDotPanel}>
        <div
          style={{
            fontFamily: fonts.sans,
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: '0.20em',
            textTransform: 'uppercase',
            color: colors.primary,
            marginBottom: 6,
          }}
        >
          Check your email
        </div>
        <p
          style={{
            margin: 0,
            color: colors.textSecondary,
            fontFamily: fonts.serif,
            fontStyle: 'italic',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          A confirmation link is on its way to{' '}
          <span style={{ color: colors.accent, fontStyle: 'normal', fontFamily: fonts.mono }}>
            {email}
          </span>
          . The link expires in 1 hour.
        </p>
      </div>
      <p
        style={{
          margin: `${spacing.md}px 0 0 0`,
          fontSize: 12,
          color: colors.textMuted,
          fontFamily: fonts.serif,
          fontStyle: 'italic',
          lineHeight: 1.6,
        }}
      >
        Didn't get it? Check your spam folder, or{' '}
        <button onClick={onResend} style={inlineLinkStyle}>
          send a new one
        </button>
        .
      </p>
    </div>
  );
}

// ── Tabs widget ────────────────────────────────────────────────────────

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <div role="tablist" style={tabBar}>
      <TabButton active={tab === 'signin'} onClick={() => onChange('signin')}>
        Sign in
      </TabButton>
      <TabButton active={tab === 'register'} onClick={() => onChange('register')}>
        Register
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        ...tabBtnBase,
        color: active ? colors.textPrimary : colors.textMuted,
        borderBottom: `2px solid ${active ? colors.primary : 'transparent'}`,
      }}
    >
      {children}
    </button>
  );
}

// ── Eyebrow + footer help ──────────────────────────────────────────────

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

function FooterHelp() {
  return (
    <div
      style={{
        fontSize: 12,
        color: colors.textMuted,
        fontFamily: fonts.serif,
        fontStyle: 'italic',
        lineHeight: 1.6,
      }}
    >
      New to Textral? See{' '}
      <a href={apiUrl('/docs')} target="_blank" rel="noopener noreferrer" style={inlineLinkStyle}>
        /docs
      </a>{' '}
      for the API reference, or read{' '}
      <a
        href="https://github.com/anthropics/textral"
        target="_blank"
        rel="noopener noreferrer"
        style={inlineLinkStyle}
      >
        SELF_HOSTING.md
      </a>{' '}
      in the repo.
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
  fontSize: 38,
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

const tabBar: CSSProperties = {
  display: 'flex',
  gap: spacing.lg,
  borderBottom: `1px solid ${colors.border}`,
};

const tabBtnBase: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '10px 0',
  fontFamily: fonts.sans,
  fontSize: 12,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  fontWeight: 500,
  cursor: 'pointer',
  transition: 'color 180ms ease, border-color 180ms ease',
  marginBottom: -1, // overlap the tab-bar border so the underline kisses it
};

const emailDotPanel: CSSProperties = {
  background: colors.bgElevated,
  border: `1px solid ${colors.borderEmphasis}`,
  borderRadius: radii.md,
  padding: '16px 18px',
};

const inlineLinkStyle: CSSProperties = {
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

const forgotLinkStyle: CSSProperties = {
  fontSize: 12,
  fontFamily: fonts.serif,
  fontStyle: 'italic',
  color: colors.textMuted,
  textDecoration: 'underline',
  textDecorationColor: colors.borderEmphasis,
  textUnderlineOffset: 3,
};
