// Provider+kind-filtered model picker with a free-text escape hatch.
// Extracted from QueryForm so Ingest can share the same widget.
//
// Dropdown lists curated registry entries from `/v1/models`; switching
// to "Custom…" reveals a text input so users can enter a model id we
// haven't added to the registry yet (mirrors the registry-staleness
// mitigation).

import { useEffect, useMemo, useState } from 'react';
import { useModelRegistry } from '../../context/ModelRegistryContext.js';
import { colors, fonts, radii, spacing } from '../../styles/tokens.js';
import type { ModelKind, ProviderName } from '../../api/types.js';

interface Props {
  label: string;
  value: string;
  provider: ProviderName | null;
  kind: ModelKind;
  onChange: (id: string) => void;
  /** Fires on every dropdown selection (registry hits only) — useful for
   *  Ingest, which auto-fills `dimensions` from the registry entry. */
  onPickKnown?: (id: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  placeholder?: string;
}

export function ModelSelectField({
  label,
  value,
  provider,
  kind,
  onChange,
  onPickKnown,
  allowEmpty,
  emptyLabel,
  placeholder,
}: Props) {
  const registry = useModelRegistry();
  const known = useMemo(
    () => (provider ? registry.filter(provider, kind) : []),
    [registry, provider, kind],
  );
  const isKnown = value === '' || known.some((m) => m.id === value);
  const [custom, setCustom] = useState(!isKnown && value !== '');

  // If the provider changes and the current model isn't in the new
  // provider's list, leave the value alone but flip into custom mode so
  // the user sees what's set instead of a silently-mismatched dropdown.
  useEffect(() => {
    if (value === '' || known.length === 0) return;
    if (!known.some((m) => m.id === value)) setCustom(true);
  }, [known, value]);

  const selectValue = custom ? '__custom__' : value;
  const showLoading = registry.loading && known.length === 0;

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
          onPickKnown?.(v);
        }}
        style={selectStyle}
        disabled={!provider}
      >
        {allowEmpty && (
          <option value="" style={{ background: colors.bgElevated }}>
            {emptyLabel ?? '(none)'}
          </option>
        )}
        {known.map((m) => (
          <option key={m.id} value={m.id} style={{ background: colors.bgElevated }}>
            {m.id}
            {m.tier ? ` · ${m.tier}` : ''}
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
          placeholder={placeholder ?? 'Type a custom model ID'}
          style={customInputStyle}
        />
      )}
      {showLoading && <div style={hintStyle}>Loading registry…</div>}
      {!provider && <div style={hintStyle}>Pick a provider first</div>}
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
