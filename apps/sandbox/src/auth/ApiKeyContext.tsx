import { createContext, useContext, useState, type ReactNode } from 'react';

const KEY_STORAGE = 'textral_api_key';

interface ApiKeyState {
  key: string | null;
  setKey: (k: string | null) => void;
}

const ApiKeyContext = createContext<ApiKeyState | null>(null);

export function useApiKey(): ApiKeyState {
  const ctx = useContext(ApiKeyContext);
  if (!ctx) throw new Error('useApiKey must be used within ApiKeyProvider');
  return ctx;
}

export function ApiKeyProvider({ children }: { children: ReactNode }) {
  const [key, setKeyState] = useState<string | null>(() => localStorage.getItem(KEY_STORAGE));
  const setKey = (k: string | null) => {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
    setKeyState(k);
  };
  return <ApiKeyContext.Provider value={{ key, setKey }}>{children}</ApiKeyContext.Provider>;
}
