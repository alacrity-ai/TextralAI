// Ingest history — paginated table of jobs across all namespaces in
// the calling tenant. Sister to QueryHistory. Click a row to expand
// the stage timeline (reuses IngestStreamLog in non-polling mode).
//
// In-flight jobs surfaced here are also tracked by ActiveJobsContext;
// this page reads its rows from a fresh paginated fetch (so we get
// older terminal jobs too) and overlays the global-context stages
// for any rows that match an active-jobs entry, so the timeline
// stays live.

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, TextralApiError } from '../api/client.js';
import type { IngestionJob, StageAttempt } from '../api/types.js';
import { useActiveJobs } from '../context/ActiveJobsContext.js';
import { useToast } from '../context/ToastContext.js';
import { Badge } from '../components/ui/Badge.js';
import { Button } from '../components/ui/Button.js';
import { Card } from '../components/ui/Card.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { Spinner } from '../components/ui/Spinner.js';
import { IngestStreamLog } from '../components/IngestStreamLog.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

const STATUS_FILTERS = ['all', 'in-flight', 'completed', 'failed'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const STATUS_TO_CSV: Record<StatusFilter, string | null> = {
  all: null,
  'in-flight': 'pending,running,retrying',
  completed: 'completed',
  failed: 'failed',
};

interface ListResponse {
  data: IngestionJob[];
  next_cursor: string | null;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function IngestHistory() {
  const activeJobs = useActiveJobs();
  const { showToast } = useToast();
  const [rows, setRows] = useState<IngestionJob[] | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [pageSize, setPageSize] = useState<PageSize>(25);
  // Cursor stack: cursors[i] is the cursor passed to fetch page i+1.
  // cursors[0] is null (first page); cursors[i>0] is the next_cursor
  // returned by page i-1. Going forward pushes; going back just
  // decrements the index (we keep the stack so re-pagination is free).
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [stageCache, setStageCache] = useState<Record<string, StageAttempt[]>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Map of live-tracked jobs from context, keyed by id, so we can
  // overlay live stages on rows that are still in flight.
  const liveById = useMemo(() => {
    const m = new Map<string, { job: IngestionJob; stages: StageAttempt[]; pollError: string | null }>();
    for (const j of activeJobs.jobs) m.set(j.job.id, j);
    return m;
  }, [activeJobs.jobs]);

  async function fetchPage(cursor: string | null) {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      const csv = STATUS_TO_CSV[filter];
      if (csv) params.set('status', csv);
      params.set('limit', String(pageSize));
      if (cursor) params.set('cursor', cursor);
      const r = await api<ListResponse>('GET', `/v1/ingestion-jobs?${params.toString()}`);
      setNextCursor(r.next_cursor);
      setRows(r.data);
      // Collapse any expanded row that's not on this page.
      setExpanded((curr) => (curr && r.data.some((j) => j.id === curr) ? curr : null));
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch on any nav change. Filter / pageSize changes reset the
  // cursor stack to a fresh first page; the second effect handles
  // page navigation within the current stack.
  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
    void fetchPage(null);
  }, [filter, pageSize]);

  useEffect(() => {
    if (cursors.length <= pageIndex) return;
    void fetchPage(cursors[pageIndex] ?? null);
    // pageIndex change is the trigger; cursors mutates in lockstep
    // when we push forward, so depending on it directly is safe.
  }, [pageIndex, cursors]);

  function gotoNextPage() {
    if (!nextCursor) return;
    // Drop anything past the current index (e.g. user went back +
    // changed filter — though filter resets the stack already).
    setCursors((prev) => [...prev.slice(0, pageIndex + 1), nextCursor]);
    setPageIndex((i) => i + 1);
  }

  function gotoPrevPage() {
    if (pageIndex === 0) return;
    setPageIndex((i) => i - 1);
  }

  async function expand(jobId: string) {
    if (expanded === jobId) {
      setExpanded(null);
      return;
    }
    setExpanded(jobId);
    if (stageCache[jobId]) return;
    // Live job? Use its already-fetched stages.
    const live = liveById.get(jobId);
    if (live) {
      setStageCache((c) => ({ ...c, [jobId]: live.stages }));
      return;
    }
    try {
      const r = await api<{ data: StageAttempt[] }>('GET', `/v1/ingestion-jobs/${jobId}/logs`);
      setStageCache((c) => ({ ...c, [jobId]: r.data }));
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Failed to load stages: ${msg}`, 'error');
    }
  }

  async function handleCancel(jobId: string) {
    try {
      await activeJobs.cancelJob(jobId);
      showToast(`Cancelling ${jobId}`, 'info');
      // Refresh the current page so the row reflects the new status.
      void fetchPage(cursors[pageIndex] ?? null);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      showToast(`Cancel failed: ${msg}`, 'error');
    }
  }

  return (
    <div style={pageStyle}>
      <PageHeader
        title="Ingest history"
        subtitle="Every ingestion job in this tenant. In-flight jobs auto-update; click a row to expand the stage timeline."
      />

      <div style={filterRow}>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            style={{
              ...filterChip,
              ...(filter === f ? filterChipActive : {}),
            }}
          >
            {f}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            color: colors.textMuted,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          <span>per page</span>
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
            style={pageSizeSelect}
            aria-label="Rows per page"
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n} style={{ background: colors.bgElevated }}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <Link
          to="/ingest"
          style={{
            marginLeft: spacing.md,
            fontSize: 12,
            color: colors.textMuted,
            textDecoration: 'none',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontFamily: "'DM Sans', sans-serif",
          }}
        >
          ← Ingest a doc
        </Link>
      </div>

      {loading && rows === null && (
        <div style={{ padding: spacing.xxl, display: 'flex', justifyContent: 'center' }}>
          <Spinner />
        </div>
      )}

      {err && rows === null && <div style={errBox}>{err}</div>}

      {rows && rows.length === 0 && (
        <EmptyState
          title="No ingestion jobs yet"
          description="Kick off your first ingest from the Ingest tab — it'll show up here."
        />
      )}

      {rows && rows.length > 0 && (
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((job) => {
              const live = liveById.get(job.id);
              const isExpanded = expanded === job.id;
              // Prefer live data for in-flight jobs (more up-to-date
              // than what was returned by /list at fetch time).
              const displayJob = live?.job ?? job;
              const displayStages = stageCache[job.id] ?? live?.stages ?? [];
              const cancelable =
                displayJob.status === 'pending' ||
                displayJob.status === 'running' ||
                displayJob.status === 'retrying';
              return (
                <div key={job.id} style={rowOuter}>
                  <button
                    type="button"
                    onClick={() => expand(job.id)}
                    style={rowButton}
                  >
                    <code style={codeStyle}>{job.id.slice(0, 18)}…</code>
                    <StatusBadge status={displayJob.status} cancelled={displayJob.error_code === 'USER_CANCELLED'} />
                    <span style={{ ...rowMono, width: 110 }}>
                      {displayJob.current_stage ?? '—'}
                    </span>
                    <span style={{ ...rowMono, width: 60 }}>
                      {displayJob.attempt_count} att
                    </span>
                    <span style={{ ...rowMono, color: colors.textMuted, flex: 1 }}>
                      {new Date(job.created_at).toLocaleString()}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: colors.textMuted,
                        letterSpacing: '0.12em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {isExpanded ? 'collapse ▲' : 'expand ▼'}
                    </span>
                  </button>
                  {isExpanded && (
                    <div style={{ padding: `0 ${spacing.md}px ${spacing.md}px` }}>
                      <IngestStreamLog
                        job={displayJob}
                        stages={displayStages}
                        startedAt={job.created_at}
                        {...(live?.pollError !== undefined ? { pollError: live.pollError } : {})}
                        {...(cancelable ? { onCancel: () => handleCancel(job.id) } : {})}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {rows && rows.length > 0 && (pageIndex > 0 || nextCursor !== null) && (
        <div
          style={{
            marginTop: spacing.lg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacing.md,
          }}
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={gotoPrevPage}
            disabled={pageIndex === 0 || loading}
          >
            ← Previous
          </Button>
          <span
            style={{
              fontSize: 11,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: colors.textMuted,
              fontFamily: "'DM Sans', sans-serif",
            }}
          >
            Page {pageIndex + 1}
            {nextCursor === null && pageIndex > 0 ? ' (last)' : ''}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={gotoNextPage}
            disabled={!nextCursor || loading}
          >
            Next →
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusBadge({
  status,
  cancelled,
}: {
  status: IngestionJob['status'];
  cancelled: boolean;
}) {
  if (cancelled) return <Badge variant="neutral">cancelled</Badge>;
  const variant: Parameters<typeof Badge>[0]['variant'] =
    status === 'completed'
      ? 'success'
      : status === 'failed'
        ? 'danger'
        : status === 'running' || status === 'retrying'
          ? 'info'
          : 'neutral';
  return <Badge variant={variant}>{status}</Badge>;
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
  width: '100%',
};

const filterRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.sm,
  marginBottom: spacing.lg,
};

const filterChip: React.CSSProperties = {
  background: 'transparent',
  color: colors.textMuted,
  border: `1px solid ${colors.border}`,
  borderRadius: 999,
  padding: '6px 14px',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  fontFamily: "'DM Sans', sans-serif",
  cursor: 'pointer',
  transition: 'background 120ms ease, color 120ms ease',
};

const pageSizeSelect: React.CSSProperties = {
  background: colors.bgInput,
  color: colors.textPrimary,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'inherit',
  cursor: 'pointer',
  outline: 'none',
};

const filterChipActive: React.CSSProperties = {
  background: colors.primaryMuted,
  color: colors.primary,
  borderColor: colors.primary,
};

const rowOuter: React.CSSProperties = {
  borderBottom: `1px solid ${colors.border}`,
};

const rowButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: spacing.md,
  width: '100%',
  padding: `${spacing.md}px ${spacing.md}px`,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  color: colors.textPrimary,
};

const rowMono: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 11,
  color: colors.textSecondary,
};

const codeStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 11,
  background: colors.bgElevated,
  color: colors.accent,
  padding: '2px 7px',
  borderRadius: 3,
  width: 200,
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
