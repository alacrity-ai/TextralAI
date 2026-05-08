// Bulk-job in-flight count, polled in the background.
//
// Sister to ActiveJobsContext (which tracks single-file ingestion
// jobs). This one is intentionally simpler — we don't need per-job
// stages or recovery, just a count-of-non-terminal for the navbar
// + inline link badges.
//
// Polls every 5s while a namespace is active. 5s is the same
// cadence as ActiveJobs and feels live enough for "you have 3 bulk
// jobs running" without being chatty for idle tenants.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../api/client.js';
import { useNamespace } from './NamespaceContext.js';

const IN_FLIGHT = new Set([
  'accepted',
  'uploading',
  'finalizing',
  'processing',
]);

const POLL_INTERVAL_MS = 5_000;

interface BulkJobsActiveState {
  /** How many bulk jobs in the active namespace are non-terminal.
   *  0 when there's no active namespace or the poll hasn't returned
   *  yet. The badge consumer renders nothing on 0. */
  inFlightCount: number;
  /** Force an immediate refetch. Call this right after a successful
   *  bulk submit so the badge appears without waiting up to 5s. */
  refresh: () => void;
}

const Ctx = createContext<BulkJobsActiveState | null>(null);

export const useBulkJobsActive = (): BulkJobsActiveState => {
  const c = useContext(Ctx);
  if (!c) {
    throw new Error('useBulkJobsActive must be used within BulkJobsActiveProvider');
  }
  return c;
};

export function BulkJobsActiveProvider({ children }: { children: ReactNode }) {
  const { active } = useNamespace();
  const [inFlightCount, setInFlightCount] = useState(0);
  // Bumping `tick` re-runs the poll-effect — used by `refresh()`.
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!active) {
      setInFlightCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const r = await api<{ data: { state: string }[] }>(
          'GET',
          `/v1/ingest/bulk?namespace=${encodeURIComponent(active.slug)}&limit=25`,
        );
        if (cancelled) return;
        const n = r.data.filter((j) => IN_FLIGHT.has(j.state)).length;
        setInFlightCount(n);
      } catch {
        // Badge is non-critical; swallow errors silently. The next
        // tick retries.
      }
    };
    void fetchCount();
    const id = window.setInterval(() => void fetchCount(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [active?.id, tick]);

  return (
    <Ctx.Provider value={{ inFlightCount, refresh }}>
      {children}
    </Ctx.Provider>
  );
}
