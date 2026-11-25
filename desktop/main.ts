/**
 * Processus principal d'Electron.
 *
 * La fenêtre charge l'application React existante, sans modification du rendu.
 * Seules les fonctions réellement impossibles dans un navigateur — OAuth avec
 * boucle locale, stockage chiffré des jetons (DPAPI), écriture sur le disque —
 * vivent ici.
 */

import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc, emitDownload, channels } from './api.ts';
import { loadEnvFile, readGoogleConfig } from './config.ts';
import { initLog, log } from './log.ts';
import { resolveDataDir, resolvePreload, resolveRendererDir } from './paths.ts';
import { Vault } from './google/vault.ts';
import { GoogleService } from './google/service.ts';
import { endpointsFromEnv } from './google/endpoints.ts';

/**
 * Le processus principal est empaqueté en CommonJS : `__dirname` est toujours
 * défini, contrairement à `import.meta.url` qui serait vide après bundling.
 */
const here = __dirname;
const devServerUrl = process.env.BOITIER_DEV_SERVER_URL;

const windows: BrowserWindow[] = [];
let service: GoogleService | null = null;
let current: BrowserWindow | null = null;
/** Chemin du journal de démarrage, affiché dans les messages d'erreur. */
let logPath: string | null = null;

/**
 * Délai maximal accordé à l'interface pour se signaler après chargement.
 * Passé ce temps, la fenêtre afficherait un cadre vide et inerte : on la
 * recharge une fois, puis on prévient l'utilisateur au lieu de le laisser
 * devant une application qui ne répond pas.
 */
const RENDERER_TIMEOUT_MS = 12_000;

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
      preload: resolvePreload(here),
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

  // Chargement de l'interface, avec un garde-fou.
  //
  // Après une mise à jour, la fenêtre peut afficher le document sans que
  // l'interface prenne la main : rien ne réagit au clic. On ne laisse pas
  // l'utilisateur devant une application morte — l'interface se signale, et à
  // défaut on recharge une fois, puis on explique.
  let signalled = false;
  let reloaded = false;
  let watchdog: NodeJS.Timeout | null = null;

  const load = () =>
    devServerUrl
      ? win.loadURL(devServerUrl)
      : win.loadFile(join(resolveRendererDir(here), 'index.html'));

  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (signalled) return;
      if (!reloaded) {
        reloaded = true;
        log('interface muette : rechargement forcé de la fenêtre');
        void load();
        return;
      }
      log('interface muette après rechargement : abandon');
      showUnresponsive(win);
    }, RENDERER_TIMEOUT_MS);
  };

  // L'interface appelle ce canal dès qu'elle est interactive (voir preload).
  // `handle` et non `handleOnce` : en développement, le double montage de
  // StrictMode émet deux signaux, et le second ne doit pas lever d'erreur.
  ipcMain.handle(channels.ready, () => {
    if (!signalled) {
      signalled = true;
      if (watchdog) clearTimeout(watchdog);
      log('interface prête');
    }
    return true;
  });

  win.webContents.on('did-finish-load', () => {
    log('document chargé');
    armWatchdog();
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`échec de chargement (${code} ${description}) : ${url}`);
    if (watchdog) clearTimeout(watchdog);
    showLoadFailure(win, `${code} ${description}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log(`processus d’affichage interrompu : ${details.reason}`);
    showLoadFailure(win, details.reason);
  });

  void load();
  return win;
}

/** Explique l'échec au lieu de laisser une fenêtre vide. */
function showLoadFailure(win: BrowserWindow, detail: string): void {
  if (win.isDestroyed()) return;
  const options = {
    type: 'error' as const,
    title: 'Interface indisponible',
    message: 'L’interface n’a pas pu être chargée.',
    detail: `Détail technique : ${detail}\n\nJournal : ${logPath ?? 'indisponible'}`,
    buttons: ['Réessayer', 'Quitter'],
    defaultId: 0,
    cancelId: 1,
  };
  const choice = dialog.showMessageBoxSync(win, options);
  if (choice === 0) win.webContents.reload();
  else app.quit();
}

/** L'interface est chargée mais ne répond pas : message clair, pas de fenêtre morte. */
function showUnresponsive(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const options = {
    type: 'warning' as const,
    title: 'Application non réactive',
    message: 'L’interface ne répond pas.',
    detail:
      'Fermez puis relancez l’application. Si le problème se reproduit, ' +
      `le journal de démarrage se trouve ici :\n${logPath ?? 'indisponible'}`,
    buttons: ['Fermer puis relancer', 'Rester ouvert'],
    defaultId: 0,
    cancelId: 1,
  };
  const choice = dialog.showMessageBoxSync(win, options);
  if (choice === 0) {
    app.relaunch();
    app.quit();
  }
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
  const dataDir = resolveDataDir(app.getPath('appData'));
  logPath = initLog(dataDir);
  log(
    `démarrage ${app.getVersion()} · ${app.isPackaged ? 'installée' : 'développement'} · ` +
      `Electron ${process.versions.electron} · ${process.platform}`,
  );

  // En développement, les identifiants peuvent venir de .env.local.
  loadEnvFile();
  const config = readGoogleConfig();
  const vault = new Vault(dataDir, protect, unprotect);
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
  log('fenêtre créée');
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
