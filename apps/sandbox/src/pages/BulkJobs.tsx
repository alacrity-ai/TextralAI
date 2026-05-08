// Bulk jobs list page — newest-first, paginated.
//
// Companion to /ingest/bulk/:id (the resume/detail page). Click any
// row to navigate into a single bulk's status; in-flight rows pulse
// to surface the awaiting-confirm / processing cases.
//
// Polling cadence: 3s while at least one in-flight row is visible,
// otherwise no polling (saves the bandwidth on a long terminal-only
// list).

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, TextralApiError } from '../api/client.js';
import { useNamespace } from '../context/NamespaceContext.js';
import { Card } from '../components/ui/Card.js';
import { Button } from '../components/ui/Button.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { Spinner } from '../components/ui/Spinner.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

interface BulkJobCounts {
  pending: number;
  uploaded: number;
  finalized: number;
  enqueued: number;
  processing: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

interface BulkJobStatus {
  bulk_job_id: string;
  state: string;
  namespace: string;
  total_files: number;
  counts: BulkJobCounts;
  progress_pct: number;
  source: string;
  created_at: number;
  completed_at: number | null;
}

interface ListResponse {
  data: BulkJobStatus[];
  next_cursor: string | null;
}

const IN_FLIGHT = new Set([
  'accepted',
  'uploading',
  'finalizing',
  'processing',
]);

export function BulkJobs() {
  const { active } = useNamespace();
  const navigate = useNavigate();
  const [rows, setRows] = useState<BulkJobStatus[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hasInFlight = useMemo(
    () => rows?.some((r) => IN_FLIGHT.has(r.state)) ?? false,
    [rows],
  );

  async function fetchPage(currentCursor: string | null, append = false) {
    if (!active) return;
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      params.set('namespace', active.slug);
      params.set('limit', '25');
      if (currentCursor) params.set('cursor', currentCursor);
      const r = await api<ListResponse>('GET', `/v1/ingest/bulk?${params}`);
      setRows((prev) => (append && prev ? [...prev, ...r.data] : r.data));
      setCursor(r.next_cursor);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  // Initial fetch + namespace change.
  useEffect(() => {
    setRows(null);
    setCursor(null);
    if (active) void fetchPage(null);
  }, [active?.id]);

  // Refresh every 3s while there's at least one in-flight row.
  // Append-mode is off so we don't drop pagination state — we just
  // re-pull the current first page.
  useEffect(() => {
    if (!hasInFlight) return;
    const id = window.setInterval(() => {
      if (active) void fetchPage(null);
    }, 3000);
    return () => window.clearInterval(id);
  }, [hasInFlight, active?.id]);

  if (!active) {
    return (
      <div style={pageStyle}>
        <EmptyState
          title="No namespace selected"
          description="Pick or create a namespace to see its bulk-ingest history."
        />
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <PageHeader
          title="Bulk jobs"
          subtitle={`Multi-file ingest history for namespace ${active.slug}. Click any row to resume or review.`}
        />
        <Link
          to="/ingest"
          style={{
            marginTop: 12,
            fontSize: 11,
            color: colors.textMuted,
            textDecoration: 'none',
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            fontFamily: "'DM Sans', sans-serif",
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            padding: '8px 14px',
            whiteSpace: 'nowrap',
          }}
        >
          ← Back to ingest
        </Link>
      </div>

      {err && (
        <div
          style={{
            padding: spacing.md,
            background: '#3a1010',
            color: '#ff8d8d',
            border: '1px solid #6a1d1d',
            borderRadius: radii.md,
            fontSize: 13,
            marginBottom: spacing.md,
          }}
        >
          {err}
        </div>
      )}

      {rows === null ? (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'center', padding: spacing.xl }}>
            <Spinner />
          </div>
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="No bulk jobs yet"
          description="Drop two or more files into the ingest page to start your first bulk job."
        />
      ) : (
        <Card>
          <div
            style={{
              border: `1px solid ${colors.border}`,
              borderRadius: radii.md,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                background: colors.bgSubtle,
                padding: '10px 16px',
                fontSize: 11,
                fontFamily: fonts.mono,
                color: colors.textMuted,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                display: 'grid',
                gridTemplateColumns: '1.5fr 110px 80px 1fr 100px',
                gap: spacing.sm,
                borderBottom: `1px solid ${colors.border}`,
              }}
            >
              <div>bulk job id</div>
              <div>state</div>
              <div>files</div>
              <div>progress</div>
              <div>age</div>
            </div>
            {rows.map((row) => (
              <BulkJobRow
                key={row.bulk_job_id}
                row={row}
                onClick={() => navigate(`/ingest/bulk/${row.bulk_job_id}`)}
              />
            ))}
          </div>

          {cursor && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: spacing.md }}>
              <Button onClick={() => void fetchPage(cursor, true)} disabled={loading}>
                {loading ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function BulkJobRow({
  row,
  onClick,
}: {
  row: BulkJobStatus;
  onClick: () => void;
}) {
  const inFlight = IN_FLIGHT.has(row.state);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      }}
      style={{
        display: 'grid',
        gridTemplateColumns: '1.5fr 110px 80px 1fr 100px',
        gap: spacing.sm,
        padding: '12px 16px',
        fontSize: 13,
        color: colors.textPrimary,
        fontFamily: fonts.mono,
        borderBottom: `1px solid ${colors.border}`,
        cursor: 'pointer',
        background: inFlight ? colors.primaryMuted : 'transparent',
        transition: 'background 200ms ease',
      }}
      onMouseEnter={(e) => {
        if (!inFlight) e.currentTarget.style.background = colors.bgSubtle;
      }}
      onMouseLeave={(e) => {
        if (!inFlight) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.bulk_job_id}
      </div>
      <StateBadge state={row.state} />
      <div style={{ color: colors.textSecondary }}>{row.total_files}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: spacing.sm }}>
        <div
          style={{
            flex: 1,
            height: 6,
            background: colors.bgInput,
            borderRadius: 3,
            overflow: 'hidden',
            maxWidth: 180,
          }}
        >
          <div
            style={{
              width: `${row.progress_pct}%`,
              height: '100%',
              background: row.counts.failed > 0 ? '#ff8d8d' : colors.primary,
            }}
          />
        </div>
        <span style={{ fontSize: 11, color: colors.textMuted }}>{row.progress_pct}%</span>
      </div>
      <div style={{ color: colors.textMuted, fontSize: 11 }}>
        {relativeTime(row.created_at)}
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const colorMap: Record<string, { bg: string; fg: string }> = {
    accepted: { bg: '#1a1a1a', fg: colors.textSecondary },
    uploading: { bg: '#2a1d04', fg: '#ffc93c' },
    finalizing: { bg: '#2a1d04', fg: '#ffc93c' },
    processing: { bg: '#2a1d04', fg: '#ffc93c' },
    complete: { bg: '#0c2812', fg: '#5bd16d' },
    partial: { bg: '#2a1d04', fg: '#ffc93c' },
    failed: { bg: '#3a1010', fg: '#ff8d8d' },
    cancelled: { bg: '#1a1a1a', fg: colors.textMuted },
    expired: { bg: '#1a1a1a', fg: colors.textMuted },
  };
  const c = colorMap[state] ?? colorMap.accepted!;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: c.bg,
        color: c.fg,
        borderRadius: 3,
        fontSize: 11,
        letterSpacing: '0.04em',
        width: 'fit-content',
      }}
    >
      {state}
    </span>
  );
}

function relativeTime(epochMs: number): string {
  const diffSec = Math.max(0, (Date.now() - epochMs) / 1000);
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  const diffMin = diffSec / 60;
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  const diffHr = diffMin / 60;
  if (diffHr < 24) return `${Math.floor(diffHr)}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
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

const pageStyle: React.CSSProperties = {
  padding: '40px 56px',
  maxWidth: 1500,
  margin: '0 auto',
};
