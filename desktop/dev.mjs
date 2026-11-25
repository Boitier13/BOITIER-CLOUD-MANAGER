/**
 * Développement de la version bureau.
 *
 * Démarre Vite, puis ouvre la fenêtre Electron sur le serveur de développement.
 * Le rafraîchissement à chaud de l'interface reste celui de Vite.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

async function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

const ready = await waitForServer('http://localhost:5173');
if (!ready) {
  console.error('Vite n’a pas démarré.');
  vite.kill();
  process.exit(1);
}

const electron = spawn(electronBinary, ['desktop/dist/main.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, BOITIER_DEV_SERVER_URL: 'http://localhost:5173' },
});

electron.on('exit', (code) => {
  vite.kill();
  process.exit(code ?? 0);
});

process.on('SIGINT', () => {
  electron.kill();
  vite.kill();
  process.exit(0);
});
