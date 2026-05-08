// Auth gate. Wraps the authenticated app subtree.
//
// When a key is in localStorage → renders `children`.
// When no key is set → renders `publicLanding` (the new Landing page
// with Sign in + Register tabs). Pre-Phase-C the gate inlined the
// API-key paste form here; that form now lives inside Landing's
// "Sign in" tab and the gate is a pure switch.
//
// The "validate the pasted key against /v1/me" interaction also moved
// into Landing's sign-in tab — keeping all UX in one component is
// simpler than threading state across a gate boundary.

import type { ReactNode } from 'react';
import { useApiKey } from './ApiKeyContext.js';

interface Props {
  publicLanding: ReactNode;
  children: ReactNode;
}

export function ApiKeyGate({ publicLanding, children }: Props) {
  const { key } = useApiKey();
  return <>{key ? children : publicLanding}</>;
}
