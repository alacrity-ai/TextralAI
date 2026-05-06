import { useState, type ReactNode } from 'react';
import { useApiKey } from './ApiKeyContext.js';
import { Button } from '../components/ui/Button.js';
import { Input } from '../components/ui/Input.js';
import { Card } from '../components/ui/Card.js';
import { colors, fonts, spacing } from '../styles/tokens.js';

export function ApiKeyGate({ children }: { children: ReactNode }) {
  const { key, setKey } = useApiKey();
  const [pending, setPending] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (key) return <>{children}</>;

  async function submit() {
    if (!pending.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/v1/me', {
        headers: { 'x-textral-api-key': pending.trim() },
      });
      if (!res.ok) {
        if (res.status === 401) setErr('Invalid API key — the server returned 401 Unauthorized.');
        else if (res.status === 404) setErr('Tenant not found for this key.');
        else setErr(`Server returned ${res.status}.`);
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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(13, 11, 9, 0.85)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 999,
      }}
    >
      <div style={{ width: 'min(560px, 92vw)' }}>
        <Card ruled style={{ padding: '40px 36px' }}>
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
          <h1
            style={{
              margin: 0,
              fontFamily: fonts.display,
              fontWeight: 400,
              fontSize: 38,
              letterSpacing: '-0.025em',
              color: colors.textPrimary,
              fontVariationSettings: '"opsz" 144, "SOFT" 30',
              marginBottom: spacing.sm,
            }}
          >
            Paste your API key
          </h1>
          <p
            style={{
              margin: 0,
              marginBottom: spacing.lg,
              fontSize: 14,
              color: colors.textSecondary,
              fontFamily: fonts.serif,
              fontStyle: 'italic',
              lineHeight: 1.55,
            }}
          >
            The sandbox stores it in <code style={codeStyle}>localStorage</code> on this machine
            only. Run <code style={codeStyle}>make selfhost-seed-cookbook</code> (or{' '}
            <code style={codeStyle}>make seed-self-host</code>) to mint one against your local
            stack.
          </p>

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

          <div style={{ marginTop: spacing.md, display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={submit} disabled={!pending.trim() || busy} loading={busy}>
              {busy ? 'Validating' : 'Continue'}
            </Button>
          </div>

          <hr className="rule" style={{ margin: `${spacing.lg}px 0` }} />

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
            <a href="/docs" target="_blank" rel="noopener noreferrer">
              /docs
            </a>{' '}
            for the API reference, or read{' '}
            <a
              href="https://github.com/anthropics/textral"
              target="_blank"
              rel="noopener noreferrer"
            >
              SELF_HOSTING.md
            </a>{' '}
            in the repo.
          </div>
        </Card>
      </div>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.88em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 6px',
  borderRadius: 3,
};
