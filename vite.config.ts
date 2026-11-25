import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Application 100 % locale : aucun proxy, aucune API distante.
 *
 * `VITE_HMR_CLIENT_PORT` permet de servir les WebSockets HMR derrière un
 * proxy HTTPS (prévisualisation distante) sans casser le développement local.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env;
const hmrClientPort = Number(env?.VITE_HMR_CLIENT_PORT ?? 0);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    ...(hmrClientPort ? { hmr: { clientPort: hmrClientPort } } : {}),
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
});
