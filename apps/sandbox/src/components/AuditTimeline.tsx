import type { QueryAudit } from '../api/types.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

interface Props {
  audit: QueryAudit;
}

// Compact at-a-glance horizontal strip. The exact per-stage timings
// aren't broken out in QueryAudit yet (only `latency_ms` total), so this
// surfaces token + retrieval composition rather than a stage waterfall.
// When the backend exposes per-stage timings (Step 23.2 follow-up), this
// component swaps to a true waterfall without API churn elsewhere.
export function AuditTimeline({ audit }: Props) {
  const totalIn = audit.tokens.embedding_input + audit.tokens.synthesis_input;
  const totalOut = audit.tokens.synthesis_output;

  return (
    <div style={wrapperStyle}>
      <div style={headerStyle}>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
            color: colors.primary,
            fontWeight: 500,
          }}
        >
          Audit at a glance
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted }}>
          {audit.latency_ms}ms total
        </div>
      </div>

      <div style={metricsRow}>
        <Metric label="Dense" value={audit.dense_candidates_returned} />
        <Metric label="Sparse" value={audit.sparse_candidates_returned} />
        <Metric label="Fused" value={audit.candidates_returned} />
        <Metric
          label="Rerank"
          value={
            audit.reranker.executed
              ? '✓'
              : audit.reranker.enabled
                ? '⊘'
                : '—'
          }
          accent={audit.reranker.executed}
          title={
            audit.reranker.executed
              ? `reranked via ${audit.reranker.provider}/${audit.reranker.model}`
              : audit.reranker.enabled
                ? `rerank skipped: ${audit.reranker.fallback_reason ?? 'fallback'}`
                : 'reranker disabled'
          }
        />
        <Metric label="Tokens in" value={totalIn} />
        <Metric label="Tokens out" value={totalOut} />
        <Metric label="Context" value={audit.tokens.context} />
        <Metric
          label="Cost"
          value={
            audit.total_cost_usd_micros !== null
              ? `$${(audit.total_cost_usd_micros / 1_000_000).toFixed(4)}`
              : '—'
          }
        />
      </div>

      <div style={composeRow}>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            color: colors.textMuted,
            marginBottom: 6,
          }}
        >
          Token composition
        </div>
        <Bar
          segments={[
            { label: 'embedding', value: audit.tokens.embedding_input, color: '#8a9a5b' },
            { label: 'synth in', value: audit.tokens.synthesis_input, color: colors.primary },
            { label: 'synth out', value: audit.tokens.synthesis_output, color: colors.accent },
          ]}
        />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
  title,
}: {
  label: string;
  value: number | string;
  accent?: boolean;
  /** Optional native browser tooltip — used to surface verbose detail
   *  (e.g. the rerank fallback_reason) without crowding the strip. */
  title?: string;
}) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      {...(title ? { title } : {})}
    >
      <span
        style={{
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: colors.textMuted,
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 16,
          color: accent ? colors.primary : colors.textPrimary,
        }}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  );
}

function Bar({ segments }: { segments: Array<{ label: string; value: number; color: string }> }) {
  const total = segments.reduce((acc, s) => acc + s.value, 0);
  if (total === 0) {
    return (
      <div
        style={{
          height: 8,
          background: colors.bgInput,
          borderRadius: 999,
          overflow: 'hidden',
        }}
      />
    );
  }
  return (
    <>
      <div
        style={{
          display: 'flex',
          height: 8,
          background: colors.bgInput,
          borderRadius: 999,
          overflow: 'hidden',
          border: `1px solid ${colors.border}`,
        }}
      >
        {segments.map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${s.value.toLocaleString()}`}
            style={{
              flexBasis: `${(s.value / total) * 100}%`,
              background: s.color,
              transition: 'flex-basis 220ms ease',
            }}
          />
        ))}
      </div>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          gap: 16,
          fontSize: 11,
          fontFamily: fonts.mono,
          color: colors.textSecondary,
          flexWrap: 'wrap',
        }}
      >
        {segments.map((s) => (
          <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                background: s.color,
                borderRadius: 2,
              }}
            />
            {s.label}: {s.value.toLocaleString()}
          </span>
        ))}
      </div>
    </>
  );
}

const wrapperStyle: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  padding: spacing.lg,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: spacing.md,
};

const metricsRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: spacing.md,
  paddingBottom: spacing.md,
  borderBottom: `1px solid ${colors.border}`,
};

const composeRow: React.CSSProperties = {
  marginTop: spacing.md,
};
