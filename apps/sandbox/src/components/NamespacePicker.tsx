import { useNamespace } from '../context/NamespaceContext.js';
import { colors, fonts, radii } from '../styles/tokens.js';

export function NamespacePicker() {
  const { list, active, setActiveBySlug, loading, error } = useNamespace();

  if (loading) {
    return (
      <span
        style={{ fontSize: 11, color: colors.textMuted, letterSpacing: '0.18em' }}
        className="smallcaps"
      >
        Loading…
      </span>
    );
  }

  if (error) {
    return (
      <span style={{ fontSize: 11, color: colors.danger, letterSpacing: '0.04em' }}>
        ns error: {error.slice(0, 40)}
      </span>
    );
  }

  if (list.length === 0) {
    return (
      <span style={{ fontSize: 11, color: colors.textMuted, fontStyle: 'italic' }}>
        no namespaces — create one in /namespaces
      </span>
    );
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: colors.bgInput,
        border: `1px solid ${colors.border}`,
        borderRadius: radii.md,
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: 9,
          fontWeight: 600,
          color: colors.primary,
          letterSpacing: '0.30em',
          textTransform: 'uppercase',
        }}
      >
        ns
      </span>
      <select
        value={active?.slug ?? ''}
        onChange={(e) => setActiveBySlug(e.target.value)}
        aria-label="Active namespace"
        style={{
          background: 'transparent',
          color: colors.textPrimary,
          border: 'none',
          outline: 'none',
          fontFamily: fonts.mono,
          fontSize: 12,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        {list.map((n) => (
          <option
            key={n.slug}
            value={n.slug}
            style={{ background: colors.bgElevated, color: colors.textPrimary }}
          >
            {n.slug} · {n.vector_backend}
          </option>
        ))}
      </select>
    </div>
  );
}
