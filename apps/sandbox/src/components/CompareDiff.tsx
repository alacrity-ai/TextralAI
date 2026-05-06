import { useMemo } from 'react';
import type { QueryResponse } from '../api/types.js';
import { Badge } from './ui/Badge.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

interface Props {
  a: QueryResponse;
  b: QueryResponse;
}

export function CompareDiff({ a, b }: Props) {
  const aIds = useMemo(() => new Set(a.citations.map((c) => c.chunk_id)), [a]);
  const bIds = useMemo(() => new Set(b.citations.map((c) => c.chunk_id)), [b]);
  const onlyA = a.citations.filter((c) => !bIds.has(c.chunk_id));
  const onlyB = b.citations.filter((c) => !aIds.has(c.chunk_id));
  const shared = a.citations.filter((c) => bIds.has(c.chunk_id));

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
          Diff
        </div>
        <div style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted }}>
          A {a.citations.length} · B {b.citations.length} · ∩ {shared.length}
        </div>
      </div>

      <div style={metricGrid}>
        <DeltaMetric
          label="latency"
          a={a.audit.latency_ms}
          b={b.audit.latency_ms}
          unit="ms"
          lowerBetter
        />
        <DeltaMetric
          label="tokens in"
          a={a.audit.tokens.embedding_input + a.audit.tokens.synthesis_input}
          b={b.audit.tokens.embedding_input + b.audit.tokens.synthesis_input}
          lowerBetter
        />
        <DeltaMetric
          label="tokens out"
          a={a.audit.tokens.synthesis_output}
          b={b.audit.tokens.synthesis_output}
        />
        <DeltaMetric
          label="candidates"
          a={a.audit.candidates_returned}
          b={b.audit.candidates_returned}
        />
        <DeltaMetric label="cited" a={a.citations.length} b={b.citations.length} />
        <DeltaMetric
          label="dropped"
          a={a.audit.dropped_citations.length}
          b={b.audit.dropped_citations.length}
          lowerBetter
        />
      </div>

      <div style={{ marginTop: spacing.lg, display: 'flex', gap: spacing.md, flexWrap: 'wrap' }}>
        <Pill
          label="A degradation"
          variant={a.degradation_level === 'full' ? 'success' : 'warning'}
        >
          {a.degradation_level}
        </Pill>
        <Pill
          label="B degradation"
          variant={b.degradation_level === 'full' ? 'success' : 'warning'}
        >
          {b.degradation_level}
        </Pill>
        <Pill
          label="A reranker"
          variant={
            a.audit.reranker.executed ? 'success' : a.audit.reranker.enabled ? 'warning' : 'neutral'
          }
        >
          {a.audit.reranker.executed ? 'ran' : a.audit.reranker.enabled ? 'fallback' : 'off'}
        </Pill>
        <Pill
          label="B reranker"
          variant={
            b.audit.reranker.executed ? 'success' : b.audit.reranker.enabled ? 'warning' : 'neutral'
          }
        >
          {b.audit.reranker.executed ? 'ran' : b.audit.reranker.enabled ? 'fallback' : 'off'}
        </Pill>
      </div>

      <hr className="rule" style={{ margin: `${spacing.lg}px 0` }} />

      <div style={citationCols}>
        <CitationList title="Only in A" tone="negative" cites={onlyA} />
        <CitationList title="Shared" tone="neutral" cites={shared} />
        <CitationList title="Only in B" tone="positive" cites={onlyB} />
      </div>
    </div>
  );
}

function DeltaMetric({
  label,
  a,
  b,
  unit,
  lowerBetter,
}: {
  label: string;
  a: number;
  b: number;
  unit?: string;
  lowerBetter?: boolean;
}) {
  const delta = b - a;
  const better = lowerBetter ? delta < 0 : delta > 0;
  const worse = delta !== 0 && !better;
  const color =
    delta === 0
      ? colors.textMuted
      : better
        ? colors.success
        : worse
          ? colors.danger
          : colors.textPrimary;
  const sign = delta > 0 ? '+' : '';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
      <span style={{ fontFamily: fonts.mono, fontSize: 14, color: colors.textPrimary }}>
        {a.toLocaleString()} → {b.toLocaleString()}
        {unit ? unit : ''}
      </span>
      <span style={{ fontFamily: fonts.mono, fontSize: 12, color }}>
        {sign}
        {delta.toLocaleString()}
        {unit ? unit : ''}
      </span>
    </div>
  );
}

function Pill({
  label,
  variant,
  children,
}: {
  label: string;
  variant: 'success' | 'warning' | 'danger' | 'neutral';
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: colors.textMuted,
        }}
      >
        {label}
      </span>
      <Badge variant={variant}>{children}</Badge>
    </div>
  );
}

function CitationList({
  title,
  tone,
  cites,
}: {
  title: string;
  tone: 'positive' | 'negative' | 'neutral';
  cites: Array<{ n: number; chunk_id: string; section_path: string | null }>;
}) {
  const accent =
    tone === 'positive' ? colors.success : tone === 'negative' ? colors.danger : colors.textMuted;
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
          color: accent,
          fontWeight: 500,
          marginBottom: spacing.sm,
        }}
      >
        {title} ({cites.length})
      </div>
      {cites.length === 0 ? (
        <div
          style={{
            color: colors.textMuted,
            fontStyle: 'italic',
            fontFamily: fonts.serif,
            fontSize: 13,
          }}
        >
          —
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {cites.map((c) => (
            <li
              key={c.chunk_id}
              style={{
                padding: '6px 10px',
                background: colors.bgInput,
                border: `1px solid ${colors.border}`,
                borderLeft: `2px solid ${accent}`,
                borderRadius: radii.sm,
                fontSize: 12,
              }}
            >
              <span style={{ color: colors.accent, fontFamily: fonts.mono, marginRight: 6 }}>
                [{c.n}]
              </span>
              <span
                style={{
                  fontFamily: fonts.serif,
                  fontStyle: c.section_path ? 'normal' : 'italic',
                  color: colors.textSecondary,
                }}
              >
                {c.section_path ?? '(no section)'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
const metricGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
  gap: spacing.md,
};
const citationCols: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: spacing.lg,
};
