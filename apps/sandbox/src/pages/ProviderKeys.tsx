import { useState } from 'react';
import { api, TextralApiError } from '../api/client.js';
import type { ProviderKey, ProviderKeyTestResponse, ProviderName } from '../api/types.js';
import { useProviderKeyRegistry } from '../context/ProviderKeyRegistryContext.js';
import { Card } from '../components/ui/Card.js';
import { Input } from '../components/ui/Input.js';
import { Button } from '../components/ui/Button.js';
import { Badge } from '../components/ui/Badge.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { Spinner } from '../components/ui/Spinner.js';
import { useToast } from '../context/ToastContext.js';
import { useConfirm } from '../context/ConfirmContext.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

const PROVIDERS: ProviderName[] = ['openai', 'anthropic', 'cohere', 'voyage', 'workers_ai'];

export function ProviderKeys() {
  const registry = useProviderKeyRegistry();
  const keys = registry.list;
  const loading = registry.loading;
  const err = registry.error;

  const [testResults, setTestResults] = useState<
    Record<string, ProviderKeyTestResponse | { error: string }>
  >({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});

  const [provider, setProvider] = useState<ProviderName>('openai');
  const [label, setLabel] = useState('default');
  const [rawKey, setRawKey] = useState('');
  const [creating, setCreating] = useState(false);

  const { showToast } = useToast();
  const confirm = useConfirm();

  async function create() {
    if (!rawKey.trim() || !label.trim()) return;
    setCreating(true);
    try {
      await api<ProviderKey>('POST', '/v1/provider-keys', {
        provider,
        label: label.trim(),
        key: rawKey,
      });
      showToast(`Registered ${provider}/${label}`, 'success');
      // Clear raw key immediately so it doesn't linger in React state.
      setRawKey('');
      setLabel('default');
      void registry.refresh();
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Register failed: ${msg}`, 'error');
    } finally {
      setCreating(false);
    }
  }

  async function remove(k: ProviderKey) {
    const ok = await confirm({
      title: 'Revoke provider key?',
      message: (
        <span>
          Soft-deletes{' '}
          <code style={codeInline}>
            {k.provider}/{k.label}
          </code>{' '}
          ({k.prefix}…). You can re-register the same label after revocation.
        </span>
      ),
      danger: true,
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    try {
      await api('DELETE', `/v1/provider-keys/${k.id}`);
      showToast(`Revoked ${k.provider}/${k.label}`, 'success');
      void registry.refresh();
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Revoke failed: ${msg}`, 'error');
    }
  }

  async function test(k: ProviderKey) {
    setTesting((t) => ({ ...t, [k.id]: true }));
    setTestResults((r) => {
      const { [k.id]: _drop, ...rest } = r;
      return rest;
    });
    try {
      const r = await api<ProviderKeyTestResponse>('POST', `/v1/provider-keys/${k.id}/test`);
      setTestResults((tr) => ({ ...tr, [k.id]: r }));
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setTestResults((tr) => ({ ...tr, [k.id]: { error: msg } }));
    } finally {
      setTesting((t) => ({ ...t, [k.id]: false }));
    }
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Provider Keys"
        subtitle="BYOK. Raw keys go to the secrets store on register and are never re-emitted by the API."
      />

      <Card ruled style={{ marginBottom: spacing.lg }}>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: colors.primary,
            marginBottom: spacing.md,
            fontWeight: 500,
          }}
        >
          Register a key
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 2fr auto',
            gap: spacing.md,
            alignItems: 'flex-end',
          }}
        >
          <SelectField
            label="Provider"
            value={provider}
            onChange={(v) => setProvider(v as ProviderName)}
            options={PROVIDERS}
          />
          <Input
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="default"
          />
          <Input
            label="Raw key (write-only)"
            type="password"
            value={rawKey}
            onChange={(e) => setRawKey(e.target.value)}
            placeholder="sk-..."
          />
          <Button
            onClick={create}
            disabled={!rawKey.trim() || !label.trim() || creating}
            loading={creating}
          >
            Register
          </Button>
        </div>
      </Card>

      {loading && (
        <div style={{ padding: spacing.xxl, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}

      {err && !loading && <div style={errBox}>{err}</div>}

      {!loading && !err && keys.length === 0 && (
        <EmptyState
          title="No provider keys registered"
          description="Register at least one key per provider (e.g. openai/default) before running queries."
        />
      )}

      {!loading && !err && keys.length > 0 && (
        <div style={tableWrap}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <Th>provider</Th>
                <Th>label</Th>
                <Th>prefix</Th>
                <Th>last validated</Th>
                <Th>last error</Th>
                <Th>created</Th>
                <Th>actions</Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const result = testResults[k.id];
                return (
                  <tr key={k.id}>
                    <Td>
                      <Badge variant="info">{k.provider}</Badge>
                    </Td>
                    <Td mono>{k.label}</Td>
                    <Td mono small>
                      {k.prefix}…
                    </Td>
                    <Td mono small>
                      {k.last_validated_at ? new Date(k.last_validated_at).toLocaleString() : '—'}
                    </Td>
                    <Td>
                      {k.last_error_code ? (
                        <Badge variant="danger">{k.last_error_code}</Badge>
                      ) : (
                        <span style={{ color: colors.textMuted }}>—</span>
                      )}
                    </Td>
                    <Td mono small>
                      {new Date(k.created_at).toLocaleDateString()}
                    </Td>
                    <Td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => test(k)}
                          loading={!!testing[k.id]}
                        >
                          Test
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => remove(k)}>
                          Revoke
                        </Button>
                        {result && 'ok' in result && result.ok && (
                          <Badge variant="success">probe ok</Badge>
                        )}
                        {result && 'ok' in result && !result.ok && (
                          <Badge variant="danger">{result.error_code ?? 'failed'}</Badge>
                        )}
                        {result && 'error' in result && (
                          <Badge variant="danger">{result.error}</Badge>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <div>
      <label
        style={{
          display: 'block',
          marginBottom: 7,
          fontSize: 11,
          color: colors.textSecondary,
          fontWeight: 500,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '11px 14px',
          background: colors.bgInput,
          color: colors.textPrimary,
          border: `1px solid ${colors.border}`,
          borderRadius: radii.md,
          fontSize: 14,
          fontFamily: "'DM Sans', sans-serif",
          outline: 'none',
          cursor: 'pointer',
        }}
      >
        {options.map((o) => (
          <option key={o} value={o} style={{ background: colors.bgElevated }}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div style={{ marginBottom: spacing.xl }}>
      <h1
        style={{
          margin: 0,
          fontFamily: fonts.display,
          fontWeight: 400,
          fontSize: 36,
          letterSpacing: '-0.025em',
          color: colors.textPrimary,
          fontVariationSettings: '"opsz" 144, "SOFT" 30',
        }}
      >
        {title}
      </h1>
      <p
        style={{
          margin: `${spacing.sm}px 0 0`,
          fontFamily: fonts.serif,
          fontStyle: 'italic',
          fontVariationSettings: '"opsz" 14, "SOFT" 80',
          color: colors.textSecondary,
          fontSize: 15,
          maxWidth: 720,
          lineHeight: 1.55,
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '10px 14px',
        textAlign: 'left',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        color: colors.textMuted,
        fontWeight: 500,
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  mono,
  small,
}: {
  children: React.ReactNode;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <td
      style={{
        padding: '12px 14px',
        fontSize: small ? 11 : 12,
        fontFamily: mono ? fonts.mono : fonts.sans,
        color: colors.textPrimary,
        borderBottom: `1px solid ${colors.border}`,
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
  );
}

const pageStyle: React.CSSProperties = {
  padding: '40px 56px',
  maxWidth: 1500,
  margin: '0 auto',
  width: '100%',
};
const tableWrap: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  overflow: 'hidden',
};
const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
};
const errBox: React.CSSProperties = {
  padding: spacing.md,
  background: 'rgba(166, 64, 56, 0.08)',
  border: `1px solid ${colors.danger}`,
  borderRadius: radii.md,
  color: colors.danger,
  fontFamily: fonts.mono,
  fontSize: 13,
};
const codeInline: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.88em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 5px',
  borderRadius: 3,
};
