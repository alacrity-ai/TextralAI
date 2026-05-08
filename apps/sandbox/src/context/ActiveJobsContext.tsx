// Global, navigation-resilient state for active ingestion jobs.
//
// The Ingest page used to hold a local `jobId` + a per-mount poller in
// IngestStreamLog; navigating away dropped both, so the user lost
// visibility into a still-running job. This provider hoists that state
// to the App level so:
//   * Navigating away from /ingest doesn't kill the polling.
//   * On app load (fresh tab, page reload), we recover any in-flight
//     jobs via `GET /v1/ingestion-jobs?status=pending,running,retrying`.
//   * The Ingest page reads + writes through this provider; the
//     IngestStreamLog becomes a presentational consumer.
//   * The navbar can render an "N jobs running" badge.
//
// Polling cadence: 1500ms per active job. We could batch with a single
// list-call per tick, but per-job round-trips also fetch `/logs` (stage
// timeline) so per-job is simpler and the per-tenant fan-out is small.
//
// Terminal jobs stay in the list for `TERMINAL_GRACE_MS` so the user
// sees the final state before the row disappears, then `dismissJob`
// removes them. The Ingest page's stream panel uses `dismissJob` from
// its Reset button.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { IngestionJob, StageAttempt } from '../api/types.js';
import { api, TextralApiError } from '../api/client.js';

const POLL_INTERVAL_MS = 1500;
const TERMINAL_GRACE_MS = 8000;

export interface ActiveJob {
  job: IngestionJob;
  stages: StageAttempt[];
  /** Set when we observe a terminal status; we keep the entry around
   *  for `TERMINAL_GRACE_MS` so the UI shows the final state, then
   *  drop. The user can also dismiss earlier via the Reset path. */
  terminalAt: number | null;
  /** Most recent error from polling this job (network failure, 401,
   *  etc.). Distinct from `job.error_code` (the job's own outcome). */
  pollError: string | null;
}

interface ActiveJobsState {
  jobs: ActiveJob[];
  /** True until the initial recovery fetch resolves on mount. The
   *  Ingest page uses this to avoid showing "no active jobs" before
   *  we've actually checked. */
  recovering: boolean;
  /** Append a job_id to the active set and start polling. The Ingest
   *  page calls this immediately after a successful dispatch so the
   *  user doesn't see a flash of "no jobs". */
  startTracking: (jobId: string) => void;
  /** POST /v1/ingestion-jobs/{id}/cancel and return the updated job.
   *  The poller picks up the new status on the next tick. */
  cancelJob: (jobId: string) => Promise<IngestionJob>;
  /** Drop the job from the active list (poller stops). Use after the
   *  user has acknowledged a terminal state. Server-side state is
   *  unchanged. */
  dismissJob: (jobId: string) => void;
  /** Force a fresh recovery fetch — useful when /ingestion-jobs lists
   *  may have lagged. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<ActiveJobsState | null>(null);

export const useActiveJobs = (): ActiveJobsState => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useActiveJobs must be used within ActiveJobsProvider');
  return c;
};

export function ActiveJobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [recovering, setRecovering] = useState(true);

  // Stable poller — one interval, polls every active job each tick.
  // The interval reads the latest jobs via a ref to avoid restarting
  // the timer on every state change.
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const upsert = useCallback((job: IngestionJob, stages: StageAttempt[]) => {
    setJobs((prev) => {
      const existing = prev.find((j) => j.job.id === job.id);
      const isTerminal = job.status === 'completed' || job.status === 'failed';
      const terminalAt = isTerminal
        ? (existing?.terminalAt ?? Date.now())
        : null;
      const next: ActiveJob = { job, stages, terminalAt, pollError: null };
      if (existing) {
        return prev.map((j) => (j.job.id === job.id ? next : j));
      }
      return [next, ...prev];
    });
  }, []);

  const recordPollError = useCallback((jobId: string, msg: string) => {
    setJobs((prev) =>
      prev.map((j) => (j.job.id === jobId ? { ...j, pollError: msg } : j)),
    );
  }, []);

  const dismissJob = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.job.id !== jobId));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ data: IngestionJob[] }>(
        'GET',
        '/v1/ingestion-jobs?status=pending,running,retrying&limit=50',
      );
      // Hydrate stages for each in-flight job in parallel; failures
      // become empty stages, the poller will retry.
      const hydrated = await Promise.all(
        r.data.map(async (job) => {
          try {
            const sRes = await api<{ data: StageAttempt[] }>(
              'GET',
              `/v1/ingestion-jobs/${job.id}/logs`,
            );
            return { job, stages: sRes.data ?? [] };
          } catch {
            return { job, stages: [] as StageAttempt[] };
          }
        }),
      );
      setJobs((prev) => {
        // Preserve any locally-tracked terminal jobs that the list
        // endpoint dropped (status filter excluded them); their grace
        // window will sweep them out.
        const recoveredIds = new Set(hydrated.map((h) => h.job.id));
        const localTerminals = prev.filter(
          (j) => j.terminalAt !== null && !recoveredIds.has(j.job.id),
        );
        const newEntries: ActiveJob[] = hydrated.map(({ job, stages }) => ({
          job,
          stages,
          terminalAt: null,
          pollError: null,
        }));
        return [...newEntries, ...localTerminals];
      });
    } catch (e) {
      // Don't surface to UI — recovery failure shouldn't break the app.
      console.warn(
        'active-jobs recovery failed:',
        e instanceof TextralApiError ? e.code : (e as Error).message,
      );
    }
  }, []);

  // Initial recovery on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      if (!cancelled) setRecovering(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Single poll loop. Polls every job that's not yet terminal +
  // sweeps out terminal jobs past the grace window.
  useEffect(() => {
    const id = window.setInterval(async () => {
      const now = Date.now();
      // Sweep grace-expired terminal jobs.
      setJobs((prev) =>
        prev.filter(
          (j) => j.terminalAt === null || now - j.terminalAt < TERMINAL_GRACE_MS,
        ),
      );
      const toPoll = jobsRef.current.filter((j) => j.terminalAt === null);
      if (toPoll.length === 0) return;
      await Promise.all(
        toPoll.map(async (active) => {
          try {
            const [j, sRes] = await Promise.all([
              api<IngestionJob>('GET', `/v1/ingestion-jobs/${active.job.id}`),
              api<{ data: StageAttempt[] }>(
                'GET',
                `/v1/ingestion-jobs/${active.job.id}/logs`,
              ).catch(() => ({ data: [] as StageAttempt[] })),
            ]);
            upsert(j, sRes.data ?? []);
          } catch (e) {
            const msg =
              e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
            recordPollError(active.job.id, msg);
          }
        }),
      );
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [upsert, recordPollError]);

  const startTracking = useCallback(
    (jobId: string) => {
      // Optimistic placeholder so the UI shows "Starting…" immediately.
      // The next poll tick replaces this with the real job state.
      setJobs((prev) => {
        if (prev.some((j) => j.job.id === jobId)) return prev;
        return [
          {
            job: {
              id: jobId,
              tenant_id: '',
              document_id: '',
              version_id: '',
              version_index_id: '',
              mode: 'full',
              status: 'pending',
              current_stage: null,
              error_code: null,
              error_message: null,
              attempt_count: 0,
              created_at: Date.now(),
              completed_at: null,
            },
            stages: [],
            terminalAt: null,
            pollError: null,
          },
          ...prev,
        ];
      });
    },
    [],
  );

  const cancelJob = useCallback(
    async (jobId: string): Promise<IngestionJob> => {
      const j = await api<IngestionJob>('POST', `/v1/ingestion-jobs/${jobId}/cancel`);
      // Eagerly upsert so the UI shows USER_CANCELLED immediately
      // instead of waiting for the next poll tick.
      setJobs((prev) =>
        prev.map((entry) =>
          entry.job.id === jobId
            ? { ...entry, job: j, terminalAt: Date.now() }
            : entry,
        ),
      );
      return j;
    },
    [],
  );

  const value = useMemo<ActiveJobsState>(
    () => ({
      jobs,
      recovering,
      startTracking,
      cancelJob,
      dismissJob,
      refresh,
    }),
    [jobs, recovering, startTracking, cancelJob, dismissJob, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
