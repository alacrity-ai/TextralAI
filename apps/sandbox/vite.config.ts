import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy forwards /v1, /healthz, /openapi.json, /docs to the local
// self-host api on :8787. Same-origin in production behind a reverse
// proxy (see apps/sandbox/nginx.conf), so app code calls `/v1/...`
// directly with no API_BASE prefix and CORS is sidestepped in both
// configurations.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:8787', changeOrigin: true },
      '/healthz': { target: 'http://localhost:8787', changeOrigin: true },
      '/openapi.json': { target: 'http://localhost:8787', changeOrigin: true },
      '/docs': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
