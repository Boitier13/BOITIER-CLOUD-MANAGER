/**
 * Processus principal d'Electron.
 *
 * La fenêtre charge l'application React existante, sans modification du rendu.
 * Seules les fonctions réellement impossibles dans un navigateur — OAuth avec
 * boucle locale, stockage chiffré des jetons (DPAPI), écriture sur le disque —
 * vivent ici.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from 'electron';
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
/** Dossier de données (coffre chiffré, journal), résolu avant `ready`. */
let dataDir: string | null = null;
/** Fenêtre d'attente affichée pendant que l'interface se prépare. */
let splash: BrowserWindow | null = null;
let splashShownAt = 0;
/** Un second clic a eu lieu avant que la première fenêtre existe. */
let revealPending = false;

/**
 * Délai maximal accordé à l'interface pour se signaler après chargement.
 * Passé ce temps, la fenêtre afficherait un cadre vide et inerte : on la
 * recharge une fois, puis on prévient l'utilisateur au lieu de le laisser
 * devant une application qui ne répond pas.
 */
const RENDERER_TIMEOUT_MS = 12_000;

/**
 * Journal dès la première milliseconde.
 *
 * Le contrôle d'instance unique arrête le processus **avant** toute écriture :
 * un second double-clic ne laissait donc aucune trace, ce qui donne
 * l'impression que l'application refuse de démarrer. On ouvre le journal
 * d'abord, on écrit le lancement, puis on contrôle l'instance — et l'on
 * explique la sortie quand elle a lieu.
 */
function startLog(): void {
  try {
    dataDir = resolveDataDir(app.getPath('appData'));
    logPath = initLog(dataDir);
  } catch {
    dataDir = null;
    logPath = null;
  }
  log(
    `démarrage ${app.getVersion()} · ${app.isPackaged ? 'installée' : 'développement'} · ` +
      `Electron ${process.versions.electron} · ${process.platform}`,
  );
}

/**
 * Écran d'attente.
 *
 * Sur un premier lancement après installation, Windows analyse longuement le
 * nouvel exécutable : la fenêtre principale peut mettre plusieurs secondes à
 * paraître. Sans repère visuel, l'application semble ne pas s'ouvrir et l'on
 * reclique — ce qui ne fait qu'ajouter une instance refusée. Ce panneau
 * s'affiche en quelques dizaines de millisecondes et disparaît dès que
 * l'interface est interactive.
 *
 * Rendu autonome (aucune ressource externe) : il ne dépend ni du disque, ni du
 * réseau, ni du dossier de l'interface.
 */
const SPLASH_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>BOITIER CLOUD MANAGER</title><style>
html,body{margin:0;height:100%;overflow:hidden}
body{background:#f5f7fb;color:#101828;font-family:'Segoe UI Variable Text','Segoe UI',system-ui,sans-serif;
display:flex;flex-direction:column;align-items:center;justify-content:center;gap:13px;
-webkit-app-region:drag;user-select:none;cursor:default}
.mark{width:44px;height:44px;border-radius:13px;background:#2f6bff;color:#fff;font-weight:700;font-size:17px;
letter-spacing:.06em;display:flex;align-items:center;justify-content:center}
h1{margin:0;font-size:13px;font-weight:700;letter-spacing:.18em}
p{margin:0;font-size:12.5px;color:#5a6473}
.bar{width:148px;height:3px;border-radius:2px;background:#e3e8f2;overflow:hidden;margin-top:3px}
.bar span{display:block;width:38%;height:100%;border-radius:2px;background:#2f6bff;
animation:run 1.15s ease-in-out infinite}
@keyframes run{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}
@media (prefers-reduced-motion:reduce){.bar span{animation:none;width:100%}}
</style></head><body>
<div class="mark">BC</div>
<h1>BOITIER CLOUD MANAGER</h1>
<p>Préparation de vos comptes…</p>
<div class="bar"><span></span></div>
</body></html>`;

function openSplash(): void {
  try {
    const win = new BrowserWindow({
      width: 420,
      height: 236,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      center: true,
      show: false,
      backgroundColor: '#f5f7fb',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.show();
    });
    // Filet : si le rendu du panneau tardait, il s'affiche quand même.
    setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 400);
    win.on('closed', () => {
      if (splash === win) splash = null;
    });
    splash = win;
    splashShownAt = Date.now();
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`);
  } catch {
    splash = null;
  }
}

/** Referme l'écran d'attente, sans clignotement quand il vient d'apparaître. */
function closeSplash(): void {
  const win = splash;
  if (!win) return;
  splash = null;
  const remaining = Math.max(0, 650 - (Date.now() - splashShownAt));
  setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, remaining);
}

/** Ramène la fenêtre existante au premier plan (clic sur l'icône déjà ouverte). */
function revealWindow(): void {
  const win = current && !current.isDestroyed() ? current : windows[0];
  if (!win || win.isDestroyed()) {
    revealPending = true;
    return;
  }
  revealPending = false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1040,
    minHeight: 680,
    // Couleur de fond avant le premier rendu : celle du thème livré, pour
    // éviter un aplat sombre devant une interface claire.
    backgroundColor: '#f5f7fb',
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

  win.once('ready-to-show', () => {
    win.show();
    // La fenêtre est peinte : l'écran d'attente n'a plus de raison d'être.
    closeSplash();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  /**
   * Menu contextuel du clic droit.
   *
   * Chromium gère les raccourcis clavier sans rien, mais un clic droit n'ouvre
   * aucun menu tant que l'application ne le construit pas : copier ou coller à
   * la souris était impossible dans les champs de l'application.
   */
  win.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: 'cut', label: 'Couper', enabled: hasSelection },
        { role: 'copy', label: 'Copier', enabled: hasSelection },
        { role: 'paste', label: 'Coller', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      );
    } else if (hasSelection) {
      template.push(
        { role: 'copy', label: 'Copier' },
        { type: 'separator' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      );
    } else {
      return;
    }
    Menu.buildFromTemplate(template).popup({ window: win });
  });
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
      closeSplash();
    }
    return true;
  });

  win.webContents.on('did-finish-load', () => {
    log('document chargé');
    armWatchdog();
  });

  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`échec de chargement (${code} ${description}) : ${url}`);
    closeSplash();
    if (watchdog) clearTimeout(watchdog);
    showLoadFailure(win, `${code} ${description}`);
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    log(`processus d’affichage interrompu : ${details.reason}`);
    closeSplash();
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
  // D'abord un repère visuel : tout le reste peut prendre du temps sur un
  // premier lancement analysé par l'antivirus.
  openSplash();
  log('écran d’attente affiché');

  // En développement, les identifiants peuvent venir de .env.local.
  loadEnvFile();
  const config = readGoogleConfig();
  const vault = new Vault(dataDir ?? resolveDataDir(app.getPath('appData')), protect, unprotect);
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

  // Un clic sur l'icône a eu lieu pendant la préparation : on montre la
  // fenêtre sans attendre un second clic de l'utilisateur.
  if (revealPending) revealWindow();
}

// Le journal est ouvert avant le contrôle d'instance : une tentative de
// lancement refusée doit laisser une trace, sinon elle est indiagnostiquable.
startLog();

// Une seule instance : le serveur de boucle locale OAuth doit être unique.
if (!app.requestSingleInstanceLock()) {
  log('une instance est déjà ouverte : ce lancement s’arrête, la fenêtre existante est réutilisée');
  app.quit();
} else {
  app.on('second-instance', () => {
    log('clic sur l’icône alors que l’application tourne déjà : retour à la fenêtre existante');
    revealWindow();
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      log('fermeture : plus aucune fenêtre');
      app.quit();
    }
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
