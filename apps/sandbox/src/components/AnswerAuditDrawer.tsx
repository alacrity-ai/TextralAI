import { useEffect } from 'react';
import { Badge } from './ui/Badge.js';
import type { QueryResponse } from '../api/types.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

interface Props {
  open: boolean;
  onClose: () => void;
  response: QueryResponse;
}

// V3-shaped audit drawer. Reads from `response.audit` directly. Compared
// to the V2 drawer (which read modelAudit/tokenUsage/classification),
// this exposes retrieval_status, citation_integrity, the reranker audit
// trio, and the four-bucket token breakdown — every field in
// QueryAudit gets its own row.
export function AnswerAuditDrawer({ open, onClose, response }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const a = response.audit;

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(response, null, 2));
  };

  return (
    <>
      <div onClick={onClose} style={backdrop} />
      <aside style={drawer} role="dialog" aria-label="Query audit">
        <header style={headerStyle}>
          <div>
            <div style={evtIdStyle}>{response.query_event_id}</div>
            <h3 style={headerTitle}>Audit drawer</h3>
          </div>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>
            ×
          </button>
        </header>

        <Section title="Outcome">
          <Row label="degradation_level">
            <DegradationBadge level={response.degradation_level} />
          </Row>
          <Row label="synthesis_status">
            <Badge
              variant={
                a.synthesis_status === 'success'
                  ? 'success'
                  : a.synthesis_status === 'truncated'
                    ? 'warning'
                    : a.synthesis_status === 'failed'
                      ? 'danger'
                      : 'neutral'
              }
            >
              {a.synthesis_status ?? 'n/a'}
            </Badge>
          </Row>
          <Row label="citation_integrity">
            <Badge
              variant={
                a.citation_integrity === 'valid'
                  ? 'success'
                  : a.citation_integrity === 'invalid_removed'
                    ? 'warning'
                    : a.citation_integrity === 'missing'
                      ? 'danger'
                      : 'neutral'
              }
            >
              {a.citation_integrity ?? 'n/a'}
            </Badge>
          </Row>
          <Row label="latency_ms">
            <Mono>{a.latency_ms.toLocaleString()}</Mono>
          </Row>
        </Section>

        <Section title="Retrieval">
          <Row label="strategy">
            <Mono>{a.retrieval_strategy}</Mono>
          </Row>
          <Row label="status">
            <Mono>{a.retrieval_status}</Mono>
          </Row>
          <Row label="dense">
            <Mono>{a.dense_candidates_returned}</Mono>
          </Row>
          <Row label="sparse">
            <Mono>{a.sparse_candidates_returned}</Mono>
          </Row>
          <Row label="fused total">
            <Mono>{a.candidates_returned}</Mono>
          </Row>
          <Row label="emb missing">
            <Mono>{a.embedding_missing_count}</Mono>
          </Row>
          <Row label="dropped citations">
            <Mono>{a.dropped_citations.length === 0 ? '—' : a.dropped_citations.join(', ')}</Mono>
          </Row>
        </Section>

        <Section title="Reranker">
          <Row label="enabled">
            <Badge variant={a.reranker.enabled ? 'info' : 'neutral'}>
              {a.reranker.enabled ? 'yes' : 'no'}
            </Badge>
          </Row>
          <Row label="executed">
            <Badge variant={a.reranker.executed ? 'success' : 'neutral'}>
              {a.reranker.executed ? 'ran' : 'skipped'}
            </Badge>
          </Row>
          {a.reranker.provider && (
            <Row label="provider">
              <Mono>{a.reranker.provider}</Mono>
            </Row>
          )}
          {a.reranker.model && (
            <Row label="model">
              <Mono>{a.reranker.model}</Mono>
            </Row>
          )}
          {a.reranker.top_n != null && (
            <Row label="top_n">
              <Mono>{a.reranker.top_n}</Mono>
            </Row>
          )}
          {a.reranker.latency_ms != null && (
            <Row label="latency_ms">
              <Mono>{a.reranker.latency_ms}</Mono>
            </Row>
          )}
          {a.reranker.fallback_reason && (
            <Row label="fallback_reason">
              <Badge variant={a.reranker.actionable ? 'danger' : 'warning'}>
                {a.reranker.fallback_reason}
              </Badge>
            </Row>
          )}
          {a.reranker.fallback_message && (
            <Row label="upstream message">
              <span style={{ fontSize: 12, fontStyle: 'italic', color: 'inherit' }}>
                {a.reranker.fallback_message}
              </span>
            </Row>
          )}
        </Section>

        <Section title="Models">
          <Row label="embedding_profile">
            <Mono>{a.embedding_profile}</Mono>
          </Row>
          <Row label="chunking_profile">
            <Mono>{a.chunking_profile}</Mono>
          </Row>
          <Row label="inference_provider">
            <Mono>{a.inference_provider}</Mono>
          </Row>
          <Row label="inference_model">
            <Mono>{a.inference_model}</Mono>
          </Row>
          <Row label="provider_key_id">
            <Mono>{a.provider_key_id ?? '—'}</Mono>
          </Row>
        </Section>

        <Section title="Tokens">
          <Row label="embedding_input">
            <Mono>{a.tokens.embedding_input.toLocaleString()}</Mono>
          </Row>
          <Row label="synthesis_input">
            <Mono>{a.tokens.synthesis_input.toLocaleString()}</Mono>
          </Row>
          <Row label="synthesis_output">
            <Mono>{a.tokens.synthesis_output.toLocaleString()}</Mono>
          </Row>
          <Row label="context">
            <Mono>{a.tokens.context.toLocaleString()}</Mono>
          </Row>
          <Row label="cost (USD)">
            <Mono>
              {a.total_cost_usd_micros !== null
                ? `$${(a.total_cost_usd_micros / 1_000_000).toFixed(6)}`
                : '—'}
            </Mono>
          </Row>
        </Section>

        <Section title="Citations">
          <Row label="returned">
            <Mono>{response.citations.length}</Mono>
          </Row>
          <Row label="answer mode">
            <Mono>{response.answer.mode}</Mono>
          </Row>
        </Section>

        <footer style={footerStyle}>
          <button onClick={copyJson} style={copyBtn}>
            Copy full response JSON
          </button>
        </footer>
      </aside>
    </>
  );
}

function DegradationBadge({ level }: { level: QueryResponse['degradation_level'] }) {
  const variant: Parameters<typeof Badge>[0]['variant'] =
    level === 'full'
      ? 'success'
      : level === 'partial'
        ? 'warning'
        : level === 'no_citations'
          ? 'warning'
          : 'danger';
  return <Badge variant={variant}>{level}</Badge>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={sectionStyle}>
      <div style={sectionTitleStyle}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={rowStyle}>
      <span style={rowLabel}>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: fonts.mono,
        fontSize: 12,
        background: colors.bgElevated,
        color: colors.accent,
        padding: '1px 6px',
        borderRadius: 3,
      }}
    >
      {children}
    </code>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  zIndex: 200,
};
const drawer: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 460,
  maxWidth: '92vw',
  background: colors.bgCard,
  borderLeft: `1px solid ${colors.border}`,
  display: 'flex',
  flexDirection: 'column',
  zIndex: 201,
  boxShadow: '-12px 0 32px rgba(0,0,0,0.55)',
  overflowY: 'auto',
  animation: 'drawer-in 220ms cubic-bezier(0.2, 0.6, 0.2, 1)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  padding: '20px 22px',
  borderBottom: `1px solid ${colors.border}`,
  position: 'sticky',
  top: 0,
  background: colors.bgCard,
  zIndex: 1,
};
const headerTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 400,
  color: colors.textPrimary,
  fontFamily: fonts.display,
  fontVariationSettings: '"opsz" 144, "SOFT" 30',
};
const evtIdStyle: React.CSSProperties = {
  fontSize: 10,
  fontFamily: fonts.mono,
  color: colors.textMuted,
  letterSpacing: '0.05em',
  marginBottom: 4,
};
const footerStyle: React.CSSProperties = {
  padding: '14px 22px',
  borderTop: `1px solid ${colors.border}`,
  marginTop: 'auto',
  position: 'sticky',
  bottom: 0,
  background: colors.bgCard,
};
const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: colors.textMuted,
  fontSize: 24,
  cursor: 'pointer',
  padding: 4,
  lineHeight: 1,
};
const sectionStyle: React.CSSProperties = {
  padding: '16px 22px',
  borderBottom: `1px solid ${colors.border}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.22em',
  color: colors.primary,
  fontWeight: 500,
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: spacing.md,
  fontSize: 13,
};
const rowLabel: React.CSSProperties = {
  color: colors.textMuted,
  fontFamily: fonts.sans,
  fontSize: 11,
  letterSpacing: '0.05em',
};
const copyBtn: React.CSSProperties = {
  background: colors.bgElevated,
  color: colors.textSecondary,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: '8px 14px',
  fontSize: 12,
  cursor: 'pointer',
  width: '100%',
  fontFamily: fonts.sans,
  letterSpacing: '0.05em',
  transition: 'color 200ms ease, border-color 200ms ease',
};
