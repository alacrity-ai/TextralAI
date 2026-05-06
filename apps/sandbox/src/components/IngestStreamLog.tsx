import { useEffect, useState } from 'react';
import type { IngestionJob, StageAttempt } from '../api/types.js';
import { api, TextralApiError } from '../api/client.js';
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
  jobId: string;
  onComplete?: (job: IngestionJob) => void;
}

export function IngestStreamLog({ jobId, onComplete }: Props) {
  const [job, setJob] = useState<IngestionJob | null>(null);
  const [stages, setStages] = useState<StageAttempt[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const elapsedTimer = window.setInterval(() => setElapsed(Date.now() - start), 250);

    let stopped = false;
    let calledComplete = false;
    async function tick() {
      while (!stopped) {
        try {
          const [j, sRes] = await Promise.all([
            api<IngestionJob>('GET', `/v1/ingestion-jobs/${jobId}`),
            api<{ data: StageAttempt[] }>('GET', `/v1/ingestion-jobs/${jobId}/logs`).catch(() => ({
              data: [] as StageAttempt[],
            })),
          ]);
          if (stopped) return;
          setJob(j);
          setStages(sRes.data ?? []);
          if (j.status === 'completed' || j.status === 'failed') {
            if (!calledComplete) {
              calledComplete = true;
              onComplete?.(j);
            }
            break;
          }
        } catch (e) {
          if (stopped) return;
          if (e instanceof TextralApiError) setErr(`${e.code}: ${e.message}`);
          else setErr((e as Error).message);
          break;
        }
        await new Promise((rs) => setTimeout(rs, 1500));
      }
    }
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(elapsedTimer);
    };
  }, [jobId, onComplete]);

  if (err) {
    return (
      <div style={{ ...wrapperStyle, borderColor: colors.danger }}>
        <div style={{ color: colors.danger, fontSize: 13 }}>{err}</div>
      </div>
    );
  }
  if (!job) {
    return (
      <div style={wrapperStyle}>
        <div style={{ color: colors.textMuted, fontSize: 13 }}>
          Starting <code style={codeStyle}>{jobId}</code>…
        </div>
      </div>
    );
  }

  const finished = job.status === 'completed' || job.status === 'failed';

  return (
    <div style={wrapperStyle}>
      <div style={headerRow}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <code style={codeStyle}>{job.id}</code>
          <StatusBadge status={job.status} />
        </div>
        <div style={{ fontSize: 11, color: colors.textMuted, fontFamily: fonts.mono }}>
          {finished
            ? `${(elapsed / 1000).toFixed(1)}s · ${job.attempt_count} attempt${job.attempt_count === 1 ? '' : 's'}`
            : `polling · ${(elapsed / 1000).toFixed(1)}s`}
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
          <strong style={{ color: colors.danger }}>{job.error_code}</strong>:{' '}
          <span style={{ color: colors.textSecondary }}>{job.error_message}</span>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: IngestionJob['status'] }) {
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
