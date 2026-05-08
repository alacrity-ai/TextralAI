// Dropdown of registered provider keys for the selected provider.
// Falls through to a free-text input when the user picks "Custom…" or
// when no provider is selected yet. The dropdown shows the key's label
// (which is what `provider_key_ref` accepts on the API).
//
// Reuses the registry from ProviderKeyRegistryContext so fresh keys
// added on /provider-keys appear immediately on Query/Ingest forms.

import { useEffect, useMemo, useState } from 'react';
import { useProviderKeyRegistry } from '../../context/ProviderKeyRegistryContext.js';
import { colors, fonts, radii, spacing } from '../../styles/tokens.js';
import type { ProviderName } from '../../api/types.js';

interface Props {
  label: string;
  value: string;
  /** When null, the dropdown disables and shows a hint. */
  provider: ProviderName | null;
  onChange: (label: string) => void;
  /** Allow an explicit "(inherit)" option whose value is empty string. */
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
}

export function ProviderKeySelectField({
  label,
  value,
  provider,
  onChange,
  allowEmpty,
  emptyLabel,
  placeholder,
}: Props) {
  const registry = useProviderKeyRegistry();
  const known = useMemo(
    () => (provider ? registry.filter(provider) : []),
    [registry, provider],
  );
  const isKnown = value === '' || known.some((k) => k.label === value);
  const [custom, setCustom] = useState(!isKnown && value !== '');

  // If the provider changes and the value isn't in the new provider's
  // keys, switch to custom mode so the user sees what's set rather than
  // a silently-mismatched dropdown.
  useEffect(() => {
    if (value === '' || known.length === 0) return;
    if (!known.some((k) => k.label === value)) setCustom(true);
  }, [known, value]);

  const selectValue = custom ? '__custom__' : value;
  const showLoading = registry.loading && known.length === 0;
  const noKeysForProvider =
    !!provider && !registry.loading && known.length === 0;

  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        value={selectValue}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__custom__') {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(v);
        }}
        style={selectStyle}
        disabled={!provider}
      >
        {allowEmpty && (
          <option value="" style={{ background: colors.bgElevated }}>
            {emptyLabel ?? '(none)'}
          </option>
        )}
        {known.map((k) => (
          <option key={k.id} value={k.label} style={{ background: colors.bgElevated }}>
            {k.label}
            {k.last_error_code ? ` · ⚠ ${k.last_error_code}` : ''}
          </option>
        ))}
        <option value="__custom__" style={{ background: colors.bgElevated }}>
          Custom…
        </option>
      </select>
      {custom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? 'Type a custom key label'}
          style={customInputStyle}
        />
      )}
      {showLoading && <div style={hintStyle}>Loading keys…</div>}
      {!provider && <div style={hintStyle}>Pick a provider first</div>}
      {noKeysForProvider && (
        <div style={hintStyle}>
          No keys registered for {provider}. Register one on /provider-keys.
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
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
      {children}
    </label>
  );
}

const selectStyle: React.CSSProperties = {
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
};

const customInputStyle: React.CSSProperties = {
  width: '100%',
  marginTop: spacing.xs,
  background: colors.bgInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: '10px 12px',
  fontSize: 13,
  fontFamily: fonts.mono,
  outline: 'none',
};

const hintStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  fontFamily: fonts.mono,
  color: colors.textMuted,
};
