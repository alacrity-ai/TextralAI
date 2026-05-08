// /redeem/:token — token redemption page.
//
// Lives outside the auth gate so users land here with no key set.
// On mount we POST the token to /v1/auth/redeem; on success we reveal
// the raw API key once, stuff it into localStorage via the apiKey
// context, and let the user click Continue to land in the gate-passed
// UI. On 410 we show "invalid or expired" + a path back to /.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApiKey } from '../auth/ApiKeyContext.js';
import { Button } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { redeem } from '../api/auth.js';
import { TextralApiError } from '../api/client.js';
import type { RedeemResponse } from '../api/types.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'success'; data: RedeemResponse }
  | { kind: 'error'; code: string; message: string };

export function Redeem() {
  const { token } = useParams<{ token: string }>();
  const { setKey } = useApiKey();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  // StrictMode double-invokes effects in dev — without a guard, the
  // single-use token gets consumed by the first call and the second
  // sees TOKEN_ALREADY_USED. The ref tracks whether redeem has fired.
  const fired = useRef(false);

  useEffect(() => {
    if (!token) {
      setPhase({ kind: 'error', code: 'NO_TOKEN', message: 'No token in URL.' });
      return;
    }
    if (fired.current) return;
    fired.current = true;

    redeem({ token })
      .then((data) => {
        setPhase({ kind: 'success', data });
      })
      .catch((e) => {
        if (e instanceof TextralApiError) {
          setPhase({ kind: 'error', code: e.code, message: e.message });
        } else {
          setPhase({
            kind: 'error',
            code: 'NETWORK',
            message: (e as Error).message,
          });
        }
      });
  }, [token]);

  function continueToSandbox() {
    if (phase.kind !== 'success') return;
    setKey(phase.data.api_key.raw);
    navigate('/', { replace: true });
  }

  return (
    <div style={pageBackdrop}>
      <div style={{ width: 'min(640px, 92vw)' }}>
        <Card ruled style={{ padding: '40px 36px' }}>
          <Eyebrow />
          {phase.kind === 'loading' && <LoadingPanel />}
          {phase.kind === 'success' && (
            <SuccessPanel data={phase.data} onContinue={continueToSandbox} />
          )}
          {phase.kind === 'error' && <ErrorPanel code={phase.code} message={phase.message} />}
        </Card>
      </div>
    </div>
  );
}

// ── Loading ────────────────────────────────────────────────────────────

function LoadingPanel() {
  return (
    <>
      <h1 style={headerTitle}>Redeeming your link…</h1>
      <p style={subtitle}>One moment while we mint your tenant.</p>
    </>
  );
}

// ── Success ────────────────────────────────────────────────────────────

function SuccessPanel({ data, onContinue }: { data: RedeemResponse; onContinue: () => void }) {
  const [copied, setCopied] = useState(false);
  const isRegister = data.namespace !== undefined;

  function copy(): void {
    void navigator.clipboard.writeText(data.api_key.raw).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <>
      <h1 style={headerTitle}>
        {isRegister ? 'Welcome to Textral' : 'Your new API key'}
      </h1>
      <p style={subtitle}>
        {isRegister
          ? `Your tenant "${data.tenant.display_name}" is live with a default namespace ready for ingest.`
          : `A fresh API key has been minted for "${data.tenant.display_name}". Your prior keys are still active — revoke them later from the Admin tab if you'd like.`}
      </p>

      <div style={warningCallout}>
        <div style={warningEyebrow}>Save this now</div>
        <p style={warningBody}>
          We will <strong>never show this key again</strong>. Copy it somewhere safe before
          continuing. If you lose it, you can request a new one via{' '}
          <code style={inlineCode}>/recover</code>.
        </p>
      </div>

      <KeyReveal value={data.api_key.raw} onCopy={copy} copied={copied} />

      <div style={metaRow}>
        <Meta label="Tenant" value={data.tenant.id} />
        {isRegister && data.namespace && <Meta label="Namespace" value={data.namespace.slug} />}
        <Meta label="Key prefix" value={data.api_key.prefix} />
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          marginTop: spacing.lg,
        }}
      >
        <Button onClick={onContinue} size="lg">
          Continue to sandbox
        </Button>
      </div>
    </>
  );
}

function KeyReveal({
  value,
  onCopy,
  copied,
}: {
  value: string;
  onCopy: () => void;
  copied: boolean;
}) {
  return (
    <div style={keyRevealOuter}>
      <code style={keyRevealValue}>{value}</code>
      <button onClick={onCopy} style={copyButton} type="button">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={metaCell}>
      <div style={metaLabel}>{label}</div>
      <code style={metaValue}>{value}</code>
    </div>
  );
}

// ── Error ──────────────────────────────────────────────────────────────

function ErrorPanel({ code, message }: { code: string; message: string }) {
  const isExpired = code === 'TOKEN_EXPIRED' || code === 'TOKEN_ALREADY_USED';

  return (
    <>
      <h1 style={headerTitle}>
        {isExpired ? 'Link is invalid or expired' : 'Something went wrong'}
      </h1>
      <p style={subtitle}>
        {isExpired
          ? code === 'TOKEN_ALREADY_USED'
            ? 'This link has already been redeemed — the API key you got from it is the one to keep. If you lost it, request a recovery email.'
            : 'Confirmation links expire one hour after they are sent, and a fresh request invalidates older links.'
          : message}
      </p>

      <div style={errorMetaRow}>
        <Meta label="Error code" value={code} />
      </div>

      <div
        style={{
          display: 'flex',
          gap: spacing.md,
          justifyContent: 'flex-end',
          marginTop: spacing.lg,
        }}
      >
        <Button variant="secondary" onClick={() => (window.location.href = '/recover')}>
          Recover an existing key
        </Button>
        <Button onClick={() => (window.location.href = '/')}>Start over</Button>
      </div>
    </>
  );
}

// ── Shared bits ────────────────────────────────────────────────────────

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

const warningCallout: CSSProperties = {
  background: 'rgba(201, 169, 97, 0.08)',
  border: `1px solid ${colors.primaryMuted}`,
  borderLeft: `3px solid ${colors.primary}`,
  borderRadius: radii.md,
  padding: '14px 18px',
  marginBottom: spacing.md,
};

const warningEyebrow: CSSProperties = {
  fontFamily: fonts.sans,
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: colors.primary,
  marginBottom: 4,
};

const warningBody: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.6,
  color: colors.textSecondary,
  fontFamily: fonts.serif,
};

const inlineCode: CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.88em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 6px',
  borderRadius: 3,
};

const keyRevealOuter: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  background: colors.bgInput,
  border: `1px solid ${colors.borderEmphasis}`,
  borderRadius: radii.md,
  padding: '10px 12px',
  marginBottom: spacing.md,
};

const keyRevealValue: CSSProperties = {
  flex: 1,
  fontFamily: fonts.mono,
  fontSize: 13,
  color: colors.accent,
  letterSpacing: '0.02em',
  overflow: 'auto',
  whiteSpace: 'nowrap',
  padding: '4px 0',
};

const copyButton: CSSProperties = {
  background: 'transparent',
  border: `1px solid ${colors.borderEmphasis}`,
  color: colors.textSecondary,
  borderRadius: radii.sm,
  padding: '6px 12px',
  fontFamily: fonts.sans,
  fontSize: 11,
  letterSpacing: '0.10em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  transition: 'color 180ms ease, border-color 180ms ease',
};

const metaRow: CSSProperties = {
  display: 'flex',
  gap: spacing.lg,
  flexWrap: 'wrap',
};

const errorMetaRow: CSSProperties = {
  marginTop: spacing.md,
};

const metaCell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
};

const metaLabel: CSSProperties = {
  fontSize: 10,
  fontFamily: fonts.sans,
  fontWeight: 500,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: colors.textMuted,
};

const metaValue: CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 12,
  color: colors.textSecondary,
  background: colors.bgElevated,
  padding: '4px 8px',
  borderRadius: 3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
