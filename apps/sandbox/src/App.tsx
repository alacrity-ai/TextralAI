import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ApiKeyProvider } from './auth/ApiKeyContext.js';
import { ApiKeyGate } from './auth/ApiKeyGate.js';
import { NamespaceProvider } from './context/NamespaceContext.js';
import { ModelRegistryProvider } from './context/ModelRegistryContext.js';
import { ProviderKeyRegistryProvider } from './context/ProviderKeyRegistryContext.js';
import { InfraKeyRegistryProvider } from './context/InfraKeyRegistryContext.js';
import { ActiveJobsProvider } from './context/ActiveJobsContext.js';
import { IngestHistory } from './pages/IngestHistory.js';
import { ToastProvider } from './context/ToastContext.js';
import { ConfirmProvider } from './context/ConfirmContext.js';
import { AppShell } from './components/layout/AppShell.js';
import { QueryBench } from './pages/QueryBench.js';
import { QueryHistory } from './pages/QueryHistory.js';
import { Ingest } from './pages/Ingest.js';
import { Compare } from './pages/Compare.js';
import { ProviderKeys } from './pages/ProviderKeys.js';
import { NamespaceList } from './pages/NamespaceList.js';
import { DocumentInspector } from './pages/DocumentInspector.js';
import { Admin } from './pages/Admin.js';

export function App() {
  return (
    <BrowserRouter>
      <ApiKeyProvider>
        <ToastProvider>
          <ConfirmProvider>
            <ApiKeyGate>
              <NamespaceProvider>
                <ModelRegistryProvider>
                <ProviderKeyRegistryProvider>
                <InfraKeyRegistryProvider>
                <ActiveJobsProvider>
                <AppShell>
                  <Routes>
                    <Route path="/" element={<QueryBench />} />
                    <Route path="/history" element={<QueryHistory />} />
                    <Route path="/ingest" element={<Ingest />} />
                    <Route path="/ingest/history" element={<IngestHistory />} />
                    <Route path="/compare" element={<Compare />} />
                    <Route path="/namespaces" element={<NamespaceList />} />
                    <Route path="/documents" element={<DocumentInspector />} />
                    <Route path="/documents/:id" element={<DocumentInspector />} />
                    <Route path="/provider-keys" element={<ProviderKeys />} />
                    <Route path="/admin" element={<Admin />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </AppShell>
                </ActiveJobsProvider>
                </InfraKeyRegistryProvider>
                </ProviderKeyRegistryProvider>
                </ModelRegistryProvider>
              </NamespaceProvider>
            </ApiKeyGate>
          </ConfirmProvider>
        </ToastProvider>
      </ApiKeyProvider>
    </BrowserRouter>
  );
}
