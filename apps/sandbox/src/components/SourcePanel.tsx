import { useEffect, useState } from 'react';
import { api, TextralApiError } from '../api/client.js';
import type { Chunk } from '../api/types.js';
import { Markdown } from './ui/Markdown.js';
import { Spinner } from './ui/Spinner.js';
import { Badge } from './ui/Badge.js';
import { useToast } from '../context/ToastContext.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

interface Props {
  chunkId: string;
  onClose: () => void;
}

// Side panel that loads a chunk's text + metadata via /v1/chunks/{id}.
// Tenant scoping happens server-side; cross-tenant probes resolve to
// 404 by design, surfaced here as the same "not found" empty state.
export function SourcePanel({ chunkId, onClose }: Props) {
  const [chunk, setChunk] = useState<Chunk | null>(null);
  const [err, setErr] = useState<{ code: string; message: string; status: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const { showToast } = useToast();

  async function copyToClipboard(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`Copied ${label} to clipboard`, 'success');
    } catch {
      // navigator.clipboard requires a secure context — fall back to
      // the legacy execCommand path so non-https/non-localhost works.
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast(`Copied ${label} to clipboard`, 'success');
      } catch (e) {
        showToast(`Copy failed: ${(e as Error).message}`, 'error');
      }
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setChunk(null);
    void (async () => {
      try {
        const r = await api<Chunk>('GET', `/v1/chunks/${chunkId}`);
        if (cancelled) return;
        setChunk(r);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof TextralApiError) {
          setErr({ code: e.code, message: e.message, status: e.status });
        } else {
          setErr({ code: 'NETWORK', message: (e as Error).message, status: 0 });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chunkId]);

  return (
    <>
      <div onClick={onClose} style={backdrop} />
      <aside style={panel} role="dialog" aria-label="Source chunk">
        <header style={headerStyle}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={evtIdStyle}>chunk</div>
            <h3 style={titleStyle}>{chunk?.section_path ?? 'Source'}</h3>
            <CopyableCode
              value={chunkId}
              onCopy={() => copyToClipboard(chunkId, 'chunk id')}
              style={chunkIdStyle}
            />
          </div>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>
            ×
          </button>
        </header>

        <div style={bodyStyle}>
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: spacing.xl }}>
              <Spinner />
            </div>
          )}

          {err && !loading && (
            <div style={errBox}>
              <div
                style={{
                  fontSize: 10,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                  color: err.status === 404 ? colors.warning : colors.danger,
                  fontWeight: 500,
                  marginBottom: spacing.sm,
                }}
              >
                {err.status === 404 ? 'Chunk not found' : "Couldn't load chunk"}
              </div>
              <div
                style={{
                  fontSize: 13,
                  color: colors.textSecondary,
                  fontFamily: fonts.serif,
                  fontStyle: 'italic',
                  lineHeight: 1.6,
                }}
              >
                {err.code}: {err.message}
                {err.status === 404 && (
                  <>
                    <br />
                    <br />
                    The id may be stale, or it may belong to another tenant. Cross-tenant probes
                    resolve to 404 by design.
                  </>
                )}
              </div>
            </div>
          )}

          {chunk && !loading && (
            <>
              <div style={metaStrip}>
                <Pill label="type" value={chunk.artifact_type} />
                <Pill label="ord" value={String(chunk.ord)} />
                <EmbeddingStatusPill status={chunk.embedding_status} />
                {chunk.embedding_dimensions != null && (
                  <Pill label="dims" value={chunk.embedding_dimensions.toLocaleString()} />
                )}
                <Pill
                  label="doc"
                  value={chunk.document_id.slice(0, 14) + '…'}
                  copyValue={chunk.document_id}
                  onCopy={() => copyToClipboard(chunk.document_id, 'document id')}
                />
              </div>

              <div style={subStrip}>
                <SubLine label="embedding">
                  <code style={codeInline}>{chunk.embedding_profile}</code>
                </SubLine>
                <SubLine label="chunking">
                  <code style={codeInline}>{chunk.chunking_profile}</code>
                </SubLine>
                <SubLine label="version">
                  <CopyableCode
                    value={chunk.version_id}
                    onCopy={() => copyToClipboard(chunk.version_id, 'version id')}
                    style={codeInline}
                  />
                </SubLine>
                {chunk.parent_chunk_id && (
                  <SubLine label="parent">
                    <CopyableCode
                      value={chunk.parent_chunk_id}
                      onCopy={() =>
                        copyToClipboard(chunk.parent_chunk_id ?? '', 'parent chunk id')
                      }
                      style={codeInline}
                    />
                  </SubLine>
                )}
                {chunk.enrichment_pass_id && (
                  <SubLine label="enrichment pass">
                    <CopyableCode
                      value={chunk.enrichment_pass_id}
                      onCopy={() =>
                        copyToClipboard(chunk.enrichment_pass_id ?? '', 'enrichment pass id')
                      }
                      style={codeInline}
                    />
                  </SubLine>
                )}
              </div>

              <hr className="rule" style={{ margin: `${spacing.md}px 0 ${spacing.lg}px` }} />

              {chunk.text ? (
                <div style={textStyle}>
                  <Markdown>{chunk.text}</Markdown>
                </div>
              ) : (
                <div style={{ color: colors.textMuted, fontStyle: 'italic' }}>
                  Chunk row found but text field is empty.
                </div>
              )}

              {chunk.metadata && Object.keys(chunk.metadata).length > 0 && (
                <details style={{ marginTop: spacing.lg }}>
                  <summary style={summaryStyle}>Metadata</summary>
                  <pre style={metadataStyle}>{JSON.stringify(chunk.metadata, null, 2)}</pre>
                </details>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function Pill({
  label,
  value,
  copyValue,
  onCopy,
}: {
  label: string;
  value: string;
  /** Optional full-fidelity value to copy when the displayed `value`
   *  is truncated (e.g. doc ids shown as `doc_…abc…`). Defaults to
   *  `value` if omitted. */
  copyValue?: string;
  /** When supplied, the pill becomes a button — click copies and toasts. */
  onCopy?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const interactive = !!onCopy;
  const fullValue = copyValue ?? value;
  const Tag: 'button' | 'span' = interactive ? 'button' : 'span';
  return (
    <Tag
      onClick={interactive ? onCopy : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={interactive ? `Copy ${fullValue}` : undefined}
      style={{
        ...pillStyle,
        ...(interactive
          ? {
              cursor: 'pointer',
              borderColor: hover ? colors.primary : colors.border,
              background: hover ? colors.primaryMuted : colors.bgElevated,
              transition: 'border-color 160ms ease, background 160ms ease',
            }
          : {}),
      }}
    >
      <span style={{ color: colors.textMuted, marginRight: 6 }}>{label}</span>
      <code style={{ color: colors.accent, fontFamily: fonts.mono }}>{value}</code>
      {interactive && (
        <span
          aria-hidden
          style={{
            marginLeft: 8,
            color: hover ? colors.primary : colors.textMuted,
            display: 'inline-flex',
            alignItems: 'center',
            transition: 'color 160ms ease',
          }}
        >
          <CopyIcon size={11} />
        </span>
      )}
    </Tag>
  );
}

/** Inline `<code>` rendering that copies its full value on click and
 *  shows a hover affordance. Used in places where the displayed text
 *  matches the copy value 1:1 (header ids, version ids, etc). */
function CopyableCode({
  value,
  onCopy,
  style,
}: {
  value: string;
  onCopy: () => void;
  style: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onCopy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Copy ${value}`}
      style={{
        background: 'transparent',
        border: 'none',
        padding: 0,
        margin: 0,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        textAlign: 'left',
      }}
    >
      <code
        style={{
          ...style,
          background: hover ? colors.primaryMuted : (style.background as string),
          color: hover ? colors.primary : (style.color as string),
          transition: 'background 160ms ease, color 160ms ease',
        }}
      >
        {value}
      </code>
      <span
        aria-hidden
        style={{
          color: hover ? colors.primary : colors.textMuted,
          display: 'inline-flex',
          alignItems: 'center',
          opacity: hover ? 1 : 0.5,
          transition: 'opacity 160ms ease, color 160ms ease',
        }}
      >
        <CopyIcon size={11} />
      </span>
    </button>
  );
}

function CopyIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function EmbeddingStatusPill({ status }: { status: Chunk['embedding_status'] }) {
  const variant: Parameters<typeof Badge>[0]['variant'] =
    status === 'embedded' ? 'success' : status === 'missing' ? 'danger' : 'warning';
  return <Badge variant={variant}>{status}</Badge>;
}

function SubLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12,
        color: colors.textSecondary,
      }}
    >
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: colors.textMuted,
          minWidth: 110,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.5)',
  zIndex: 220,
};
const panel: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  right: 0,
  bottom: 0,
  width: 560,
  maxWidth: '92vw',
  background: colors.bgCard,
  borderLeft: `1px solid ${colors.border}`,
  zIndex: 221,
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '-12px 0 32px rgba(0,0,0,0.55)',
  animation: 'drawer-in 220ms cubic-bezier(0.2, 0.6, 0.2, 1)',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: spacing.md,
  padding: '20px 22px',
  borderBottom: `1px solid ${colors.border}`,
};
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: fonts.display,
  fontWeight: 400,
  fontSize: 22,
  letterSpacing: '-0.02em',
  color: colors.textPrimary,
  fontVariationSettings: '"opsz" 144, "SOFT" 30',
  marginBottom: 4,
};
const chunkIdStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 11,
  color: colors.textMuted,
  display: 'inline-block',
  marginTop: 4,
  wordBreak: 'break-all',
};
const evtIdStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: colors.primary,
  fontWeight: 500,
  marginBottom: 6,
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
const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px 22px',
};
const metaStrip: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: spacing.sm,
  marginBottom: spacing.md,
  alignItems: 'center',
};
const subStrip: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: spacing.sm,
};
const pillStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  background: colors.bgElevated,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.full,
  fontSize: 11,
  fontFamily: fonts.sans,
};
const textStyle: React.CSSProperties = {
  fontFamily: fonts.serif,
  fontSize: 15,
  lineHeight: 1.7,
  color: colors.textPrimary,
  fontVariationSettings: '"opsz" 14, "SOFT" 30',
};
const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontSize: 11,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: colors.primary,
  fontWeight: 500,
  marginBottom: spacing.sm,
};
const metadataStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 12,
  background: colors.bgInput,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.md,
  padding: spacing.md,
  overflow: 'auto',
  color: colors.textSecondary,
  whiteSpace: 'pre',
};
const errBox: React.CSSProperties = {
  padding: spacing.md,
  background: 'rgba(166, 64, 56, 0.06)',
  border: `1px solid ${colors.danger}`,
  borderRadius: radii.md,
  color: colors.textPrimary,
  fontSize: 13,
};
const codeInline: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: '0.92em',
  background: colors.bgElevated,
  color: colors.accent,
  padding: '1px 6px',
  borderRadius: 3,
};
