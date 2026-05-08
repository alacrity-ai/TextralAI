// Presentational stream-log for an ingestion job. Polling lives in
// ActiveJobsContext; this component just renders whatever shape it's
// handed and surfaces a Cancel button when the job is still running.

import { useEffect, useState } from 'react';
import type { IngestionJob, StageAttempt } from '../api/types.js';
import { Badge } from './ui/Badge.js';
import { colors, fonts, radii, spacing } from '../styles/tokens.js';

const STAGE_ORDER = [
  'queued',
  'fetched',
  'normalized',
  'chunked',
  'embedded',
  'indexed',
  'enriched',
];

interface Props {
  job: IngestionJob;
  stages: StageAttempt[];
  /** Wall-clock ms since the user started this job (for the timer
   *  pill). Optional — if omitted we time from the first render of
   *  this row. The Ingest page passes elapsed since dispatch; the
   *  History page omits and we time-since-mount instead. */
  startedAt?: number;
  /** Surfaced when the poller hits an error talking to /ingestion-jobs. */
  pollError?: string | null;
  /** Called when the user clicks Cancel. Hidden if not provided
   *  (e.g. on the History page for a long-since-completed job). */
  onCancel?: () => void;
}

export function IngestStreamLog({ job, stages, startedAt, pollError, onCancel }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const start = startedAt ?? Date.now();
    const id = window.setInterval(() => setElapsed(Date.now() - start), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const finished = job.status === 'completed' || job.status === 'failed';
  const cancelled = job.error_code === 'USER_CANCELLED';
  const showCancel = !finished && !cancelling && onCancel !== undefined;

  return (
    <div style={wrapperStyle}>
      <div style={headerRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <code style={codeStyle}>{job.id}</code>
          <StatusBadge status={job.status} cancelled={cancelled} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
            {finished
              ? `${(elapsed / 1000).toFixed(1)}s · ${job.attempt_count} attempt${job.attempt_count === 1 ? '' : 's'}`
              : `polling · ${(elapsed / 1000).toFixed(1)}s`}
          </div>
          {showCancel && (
            <button
              type="button"
              onClick={async () => {
                setCancelling(true);
                try {
                  await onCancel!();
                } finally {
                  // The poller will flip the badge to USER_CANCELLED
                  // within a tick or two; we just unblock the local
                  // button state.
                  setCancelling(false);
                }
              }}
              style={cancelButtonStyle}
              aria-label="Cancel job"
            >
              Cancel
            </button>
          )}
          {cancelling && (
            <span
              style={{
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: colors.textMuted,
              }}
            >
              cancelling…
            </span>
          )}
        </div>
      </div>

      <div style={stageRow}>
        {STAGE_ORDER.map((stage) => {
          const att = [...stages].reverse().find((s) => s.stage === stage);
          const isCurrent = job.current_stage === stage && !finished;
          const isDone = att?.status === 'completed';
          const isFailed = att?.status === 'failed';
          const isSkipped = att?.status === 'skipped';
          return (
            <div
              key={stage}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                opacity: isCurrent || isDone || isFailed || isSkipped ? 1 : 0.4,
              }}
            >
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: isFailed
                    ? colors.danger
                    : isSkipped
                      ? colors.textMuted
                      : isDone
                        ? colors.success
                        : isCurrent
                          ? colors.primary
                          : 'transparent',
                  border: `1px solid ${isCurrent ? colors.primary : colors.border}`,
                  animation: isCurrent ? 'pulse-gold 1.4s ease-in-out infinite' : 'none',
                }}
              />
              <div
                style={{
                  fontSize: 9,
                  letterSpacing: '0.18em',
                  textTransform: 'uppercase',
                  color: isCurrent
                    ? colors.primary
                    : isDone
                      ? colors.textSecondary
                      : isFailed
                        ? colors.danger
                        : colors.textMuted,
                }}
              >
                {stage}
              </div>
              {att?.duration_ms !== null && att?.duration_ms !== undefined && (
                <div style={{ fontSize: 10, color: colors.textMuted, fontFamily: fonts.mono }}>
                  {att.duration_ms}ms
                </div>
              )}
            </div>
          );
        })}
      </div>

      {stages.length > 0 && (
        <div style={detailList}>
          {stages.map((s) => (
            <div key={`${s.stage}-${s.attempt}`} style={detailRow}>
              <span style={{ color: colors.textMuted, fontFamily: fonts.mono, fontSize: 11 }}>
                {new Date(s.started_at).toLocaleTimeString()}
              </span>
              <span
                style={{
                  fontSize: 11,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: colors.textSecondary,
                  width: 100,
                }}
              >
                {s.stage}
              </span>
              <span
                style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.textMuted, width: 70 }}
              >
                {s.duration_ms !== null ? `${s.duration_ms}ms` : '—'}
              </span>
              <StageStatusBadge status={s.status} />
              {s.error_message && (
                <span style={{ fontSize: 12, color: colors.danger, fontStyle: 'italic' }}>
                  {s.error_code}: {s.error_message}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {job.error_code && (
        <div style={errorBox}>
          <strong style={{ color: cancelled ? colors.textSecondary : colors.danger }}>
            {job.error_code}
          </strong>
          : <span style={{ color: colors.textSecondary }}>{job.error_message}</span>
        </div>
      )}

      {pollError && !job.error_code && (
        <div style={{ ...errorBox, fontSize: 12 }}>
          <strong style={{ color: colors.danger }}>poll error</strong>:{' '}
          <span style={{ color: colors.textSecondary }}>{pollError}</span>
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

function StageStatusBadge({ status }: { status: StageAttempt['status'] }) {
  const variant: Parameters<typeof Badge>[0]['variant'] =
    status === 'completed'
      ? 'success'
      : status === 'failed'
        ? 'danger'
        : status === 'skipped'
          ? 'neutral'
          : 'info';
  return <Badge variant={variant}>{status}</Badge>;
}

const wrapperStyle: React.CSSProperties = {
  background: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: radii.lg,
  padding: spacing.lg,
  display: 'flex',
  flexDirection: 'column',
  gap: spacing.md,
};

const headerRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const stageRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: spacing.sm,
  paddingTop: spacing.sm,
  paddingBottom: spacing.md,
  borderBottom: `1px solid ${colors.border}`,
};

const detailList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  fontSize: 12,
};

const detailRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
};

const codeStyle: React.CSSProperties = {
  fontFamily: fonts.mono,
  fontSize: 12,
  background: colors.bgElevated,
  color: colors.accent,
  padding: '2px 7px',
  borderRadius: 3,
};

const errorBox: React.CSSProperties = {
  marginTop: spacing.sm,
  padding: spacing.sm,
  background: 'rgba(166, 64, 56, 0.08)',
  border: `1px solid ${colors.danger}`,
  borderRadius: radii.md,
  fontSize: 12,
  fontFamily: fonts.mono,
};

const cancelButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: colors.danger,
  border: `1px solid ${colors.danger}`,
  borderRadius: radii.sm,
  padding: '4px 10px',
  fontSize: 11,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  fontFamily: "'DM Sans', sans-serif",
  cursor: 'pointer',
  transition: 'background 120ms ease',
};
