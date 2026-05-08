// Centralized cache of `/v1/provider-keys`. Mirrors ModelRegistryContext.
// Fetched once on mount, refreshed after the user creates/revokes a key
// on the ProviderKeys page so other forms see fresh dropdowns without
// reload.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ProviderKey, ProviderName } from '../api/types.js';
import { api, TextralApiError } from '../api/client.js';

interface RegistryState {
  list: ProviderKey[];
  loading: boolean;
  error: string | null;
  /** All non-revoked keys for `provider`, in registration order (oldest first). */
  filter: (provider: ProviderName) => ProviderKey[];
  /** Look up a key by its label (the `provider_key_ref` users see). */
  byLabel: (provider: ProviderName, label: string) => ProviderKey | undefined;
  refresh: () => Promise<void>;
}

const Ctx = createContext<RegistryState | null>(null);

export const useProviderKeyRegistry = (): RegistryState => {
  const c = useContext(Ctx);
  if (!c) {
    throw new Error('useProviderKeyRegistry must be used within ProviderKeyRegistryProvider');
  }
  return c;
};

export function ProviderKeyRegistryProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ data: ProviderKey[] }>('GET', '/v1/provider-keys');
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
      filter: (provider) => list.filter((k) => k.provider === provider),
      byLabel: (provider, label) =>
        list.find((k) => k.provider === provider && k.label === label),
      refresh,
    }),
    [list, loading, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
