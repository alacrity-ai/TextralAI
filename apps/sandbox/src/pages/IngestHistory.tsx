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

export function IngestHistory() {
  const activeJobs = useActiveJobs();
  const { showToast } = useToast();
  const [rows, setRows] = useState<IngestionJob[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
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

  async function fetchPage(cursor: string | null = null, replace = true) {
    setLoading(true);
    setErr(null);
    try {
      const params = new URLSearchParams();
      const csv = STATUS_TO_CSV[filter];
      if (csv) params.set('status', csv);
      params.set('limit', '50');
      if (cursor) params.set('cursor', cursor);
      const r = await api<ListResponse>('GET', `/v1/ingestion-jobs?${params.toString()}`);
      setNextCursor(r.next_cursor);
      setRows((prev) => (replace || !prev ? r.data : [...prev, ...r.data]));
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch when the filter chip changes. fetchPage isn't a dep
  // (it's stable enough — closes over `filter` already and we don't
  // memoize it; including it would just thrash the effect).
  useEffect(() => {
    void fetchPage(null, true);
  }, [filter]); // fetchPage intentionally excluded

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
      // Refresh the list so the row reflects the new status.
      void fetchPage(null, true);
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
        <Link
          to="/ingest"
          style={{
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

      {nextCursor && (
        <div style={{ marginTop: spacing.lg, display: 'flex', justifyContent: 'center' }}>
          <Button
            variant="secondary"
            onClick={() => fetchPage(nextCursor, false)}
            loading={loading}
          >
            Load more
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
