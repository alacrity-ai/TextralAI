// Centralized cache of `/v1/infra-keys`. Sister to
// ProviderKeyRegistryContext; same shape, different endpoint.
// Refreshed after register/revoke on the Provider Keys page so the
// table updates without reload (and any future surface that needs to
// know whether an infra key is registered can read from here too).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { InfraKey, InfraProviderName } from '../api/types.js';
import { api, TextralApiError } from '../api/client.js';

interface RegistryState {
  list: InfraKey[];
  loading: boolean;
  error: string | null;
  /** The active key for `provider`, or undefined. KISS rule: at most
   *  one active per (tenant, provider). */
  activeFor: (provider: InfraProviderName) => InfraKey | undefined;
  refresh: () => Promise<void>;
}

const Ctx = createContext<RegistryState | null>(null);

export const useInfraKeyRegistry = (): RegistryState => {
  const c = useContext(Ctx);
  if (!c) {
    throw new Error('useInfraKeyRegistry must be used within InfraKeyRegistryProvider');
  }
  return c;
};

export function InfraKeyRegistryProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<InfraKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ data: InfraKey[] }>('GET', '/v1/infra-keys');
      setList(r.data);
    } catch (e) {
      const msg = e instanceof TextralApiError ? `${e.code}: ${e.message}` : (e as Error).message;
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<RegistryState>(
    () => ({
      list,
      loading,
      error,
      activeFor: (provider) => list.find((k) => k.provider === provider),
      refresh,
    }),
    [list, loading, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
