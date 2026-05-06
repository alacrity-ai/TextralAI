import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Namespace } from '../api/types.js';
import { api, TextralApiError } from '../api/client.js';

const STORAGE_KEY = 'textral_active_namespace';

interface NamespaceState {
  list: Namespace[];
  active: Namespace | null;
  loading: boolean;
  error: string | null;
  setActiveBySlug: (slug: string) => void;
  refresh: () => Promise<void>;
}

const NamespaceContext = createContext<NamespaceState | null>(null);

export const useNamespace = (): NamespaceState => {
  const c = useContext(NamespaceContext);
  if (!c) throw new Error('useNamespace must be used within NamespaceProvider');
  return c;
};

export function NamespaceProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Namespace[]>([]);
  const [activeSlug, setActiveSlugState] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ data: Namespace[] }>('GET', '/v1/namespaces');
      setList(r.data);
      const stored = localStorage.getItem(STORAGE_KEY);
      const stillExists = stored && r.data.some((n) => n.slug === stored);
      if (!stillExists && r.data.length > 0) {
        const first = r.data[0]!;
        localStorage.setItem(STORAGE_KEY, first.slug);
        setActiveSlugState(first.slug);
      }
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

  const setActiveBySlug = (slug: string) => {
    localStorage.setItem(STORAGE_KEY, slug);
    setActiveSlugState(slug);
  };

  const active = list.find((n) => n.slug === activeSlug) ?? null;

  return (
    <NamespaceContext.Provider value={{ list, active, loading, error, setActiveBySlug, refresh }}>
      {children}
    </NamespaceContext.Provider>
  );
}
