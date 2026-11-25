/**
 * Processus principal d'Electron.
 *
 * La fenêtre charge l'application React existante, sans modification du rendu.
 * Seules les fonctions réellement impossibles dans un navigateur — OAuth avec
 * boucle locale, stockage chiffré des jetons (DPAPI), écriture sur le disque —
 * vivent ici.
 */

import { app, BrowserWindow, safeStorage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { registerIpc, emitDownload } from './api.ts';
import { loadEnvFile, readGoogleConfig } from './config.ts';
import { Vault } from './google/vault.ts';
import { GoogleService } from './google/service.ts';
import { endpointsFromEnv } from './google/endpoints.ts';

const here = dirname(fileURLToPath(import.meta.url));
const devServerUrl = process.env.BOITIER_DEV_SERVER_URL;

const windows: BrowserWindow[] = [];
let service: GoogleService | null = null;
let current: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: '#0b0d10',
    show: false,
    title: 'BOITIER CLOUD MANAGER',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devServerUrl ?? 'file://';
    if (!url.startsWith(allowed)) {
      event.preventDefault();
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(resolve(here, '../dist/index.html'));

  return win;
}

function protect(plain: string): Buffer | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(plain);
}

function unprotect(cipher: Buffer): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(cipher);
  } catch {
    return null;
  }
}

function boot(): void {
  // En développement, les identifiants peuvent venir de .env.local.
  loadEnvFile();
  const config = readGoogleConfig();
  const vault = new Vault(app.getPath('userData'), protect, unprotect);
  const win = createWindow();
  windows.push(win);
  current = win;

  service = new GoogleService({
    vault,
    userDataDir: app.getPath('userData'),
    openExternal: (url) => void shell.openExternal(url),
    downloadsDir: async () => app.getPath('downloads'),
    emitDownload: (event) => {
      for (const target of windows) if (!target.isDestroyed()) emitDownload(target, event);
    },
    endpoints: endpointsFromEnv(),
    ...(config.clientId ? { clientId: config.clientId } : {}),
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
  });

  registerIpc(win, service);

  win.webContents.on('did-finish-load', () => {
    void win.webContents.executeJavaScript('void 0');
  });
}

// Une seule instance : le serveur de boucle locale OAuth doit être unique.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = windows[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      current = createWindow();
      windows.push(current);
    }
  });

  // Diffusion vers la fenêtre active (une seule fenêtre en pratique).
  app.on('browser-window-focus', (_event, win) => {
    current = win;
  });
}
