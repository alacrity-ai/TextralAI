import { useEffect, useRef } from 'react';
import { Markdown } from './ui/Markdown.js';
import { Badge } from './ui/Badge.js';
import { Button } from './ui/Button.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';
import type { QueryResponse } from '../api/types.js';

interface Props {
  response: QueryResponse;
  streaming?: boolean;
  streamingText?: string;
  /** Marks this card as showing a historical (replay) answer, not a
   *  fresh run. Adds a "from history" badge so the operator can tell
   *  which is which after they hit Run. */
  historical?: boolean;
  onOpenAudit: () => void;
  onCitationClick?: (chunkId: string) => void;
}

export function AnswerCard({
  response,
  streaming,
  streamingText,
  historical,
  onOpenAudit,
  onCitationClick,
}: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [response.query_event_id]);

  const isText = response.answer.mode === 'text';
  const liveText = streaming && streamingText !== undefined ? streamingText : null;
  const text = liveText ?? (response.answer.mode === 'text' ? response.answer.text : '');

  // Replace [n] markers with clickable citation marks (text mode only).
  const rendered = isText ? injectCitationMarks(text, response.citations) : null;

  const degradationVariant: Parameters<typeof Badge>[0]['variant'] =
    response.degradation_level === 'full'
      ? 'success'
      : response.degradation_level === 'partial' || response.degradation_level === 'no_citations'
        ? 'warning'
        : 'danger';

  return (
    <div
      ref={cardRef}
      style={{
        ...cardStyle,
        ...(historical
          ? {
              borderColor: colors.primary,
              borderLeft: `3px solid ${colors.primary}`,
            }
          : {}),
      }}
    >
      <div style={topRow}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {historical && <Badge variant="info">from history</Badge>}
          <Badge variant={degradationVariant}>{response.degradation_level}</Badge>
          {response.audit.synthesis_status && (
            <Badge variant={response.audit.synthesis_status === 'success' ? 'success' : 'warning'}>
              {response.audit.synthesis_status}
            </Badge>
          )}
          {response.audit.reranker.executed && (
            <Badge variant="info">
              reranked · {response.audit.reranker.provider}/{response.audit.reranker.model}
            </Badge>
          )}
          {response.audit.reranker.enabled && !response.audit.reranker.executed && (
            <Badge variant="warning">
              rerank fallback: {response.audit.reranker.fallback_reason}
            </Badge>
          )}
          <span style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
            {response.audit.latency_ms}ms · {response.audit.candidates_returned} candidates ·{' '}
            {response.citations.length} cited
          </span>
        </div>
        <Button variant="secondary" size="sm" onClick={onOpenAudit}>
          Audit drawer
        </Button>
      </div>

      <hr className="rule" style={{ margin: `${spacing.md}px 0` }} />

      <div style={answerStyle}>
        {isText ? (
          <div style={{ position: 'relative' }}>
            <Markdown>{rendered ?? text}</Markdown>
            {streaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: 8,
                  height: 16,
                  background: colors.primary,
                  marginLeft: 4,
                  verticalAlign: 'text-bottom',
                  animation: 'pulse-gold 1s ease-in-out infinite',
                }}
              />
            )}
          </div>
        ) : (
          <pre style={structuredStyle}>
            {JSON.stringify(
              response.answer.mode === 'structured' ? response.answer.object : null,
              null,
              2,
            )}
          </pre>
        )}
      </div>

      {response.citations.length > 0 && (
        <>
          <hr className="rule" style={{ margin: `${spacing.lg}px 0 ${spacing.md}px` }} />
          <div
            style={{
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.22em',
              color: colors.primary,
              fontWeight: 500,
              marginBottom: spacing.sm,
            }}
          >
            Citations
          </div>
          <ol style={citationList}>
            {response.citations.map((c) => (
              <li key={`${c.chunk_id}-${c.n}`} style={citationItem}>
                <button
                  onClick={() => onCitationClick?.(c.chunk_id)}
                  style={citationButton}
                  title={c.chunk_id}
                >
                  <span
                    style={{
                      fontFamily: fonts.mono,
                      fontSize: 10,
                      color: colors.primary,
                      width: 24,
                      textAlign: 'right',
                      letterSpacing: '0.05em',
                    }}
                  >
                    [{c.n}]
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: fonts.serif,
                        fontStyle: c.section_path ? 'normal' : 'italic',
                        color: colors.textSecondary,
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {c.section_path ?? '(no section path)'}
                    </div>
                    {c.quote && (
                      <div
                        style={{
                          fontFamily: fonts.serif,
                          fontStyle: 'italic',
                          color: colors.textMuted,
                          fontSize: 12,
                          marginTop: 2,
                          lineHeight: 1.4,
                        }}
                      >
                        "{c.quote}"
                      </div>
                    )}
                  </div>
                  <code style={chunkIdStyle}>{c.chunk_id.slice(0, 12)}…</code>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function injectCitationMarks(text: string, citations: QueryResponse['citations']): string {
  // Re-renders the answer text but wraps `[n]` patterns whose `n` matches
  // a returned citation in a styled span with a hash anchor — react-markdown
  // re-emits the spans as inline HTML if the input markdown has them. In
  // practice the model already emits raw `[n]` and we render them as plain
  // brackets; this is just the hook for richer styling later. For now,
  // return the text as-is so react-markdown handles it cleanly.
  void citations;
  return text;
}

const cardStyle: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  padding: spacing.lg,
};

const topRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: spacing.md,
};

const answerStyle: React.CSSProperties = {
  color: colors.textPrimary,
  fontFamily: fonts.serif,
  fontSize: 16,
  lineHeight: 1.65,
  fontVariationSettings: '"opsz" 14, "SOFT" 30',
};

const structuredStyle: React.CSSProperties = {
  background: colors.bgInput,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: spacing.md,
  fontFamily: fonts.mono,
  fontSize: 12,
  color: colors.textPrimary,
  overflow: 'auto',
  whiteSpace: 'pre',
};

const citationList: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const citationItem: React.CSSProperties = {
  margin: 0,
};

const citationButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '8px 12px',
  width: '100%',
  background: 'transparent',
  border: `1px solid transparent`,
  borderRadius: radii.md,
  cursor: 'pointer',
  textAlign: 'left',
  transition: 'background 200ms ease, border-color 200ms ease',
};

const chunkIdStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 10,
  color: colors.textMuted,
  background: colors.bgElevated,
  padding: '1px 6px',
  borderRadius: 3,
  whiteSpace: 'nowrap',
};
