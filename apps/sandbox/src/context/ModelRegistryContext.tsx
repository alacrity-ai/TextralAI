import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { KnownModel, ModelKind, ProviderName } from '../api/types.js';
import { api, TextralApiError } from '../api/client.js';

interface RegistryState {
  list: KnownModel[];
  loading: boolean;
  error: string | null;
  /** Filtered view, deprecated-hidden by default. */
  filter: (provider: ProviderName, kind: ModelKind) => KnownModel[];
  /** Look up a model by id; undefined when not in the registry. */
  byId: (id: string) => KnownModel | undefined;
  refresh: () => Promise<void>;
}

const Ctx = createContext<RegistryState | null>(null);

export const useModelRegistry = (): RegistryState => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useModelRegistry must be used within ModelRegistryProvider');
  return c;
};

export function ModelRegistryProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<KnownModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ data: KnownModel[] }>('GET', '/v1/models');
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
      filter: (provider, kind) =>
        list.filter((m) => m.provider === provider && m.kind === kind && !m.deprecated),
      byId: (id) => list.find((m) => m.id === id),
      refresh,
    }),
    [list, loading, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
