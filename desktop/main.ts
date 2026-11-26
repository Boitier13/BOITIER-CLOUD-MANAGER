/**
 * Processus principal d'Electron.
 *
 * La fenêtre charge l'application React existante, sans modification du rendu.
 * Seules les fonctions réellement impossibles dans un navigateur — OAuth avec
 * boucle locale, stockage chiffré des jetons (DPAPI), écriture sur le disque —
 * vivent ici.
 */

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  shell,
} from 'electron';
import { join } from 'node:path';
import { registerIpc, emitDownload, emitUpdate, emitUpload, channels } from './api.ts';
import { MegaVault } from './mega/store.ts';
import { MegaSession } from './mega/session.ts';
import { MegaService } from './mega/service.ts';
import { traceMiseAJour, Updater } from './updater.ts';
import { loadEnvFile, readGoogleConfig } from './config.ts';
import { initLog, log, logPath as currentLogPath, sinceStart } from './log.ts';
import { resolveDataDir, resolvePreload, resolveRendererDir } from './paths.ts';
import { defaultDownloadDir } from '../src/lib/downloadFolder.ts';
import type { DownloadEvent } from './google/downloads.ts';
import { Vault } from './google/vault.ts';
import { GoogleService } from './google/service.ts';
import { endpointsFromEnv } from './google/endpoints.ts';

/**
 * Le processus principal est empaqueté en CommonJS : `__dirname` est toujours
 * défini, contrairement à `import.meta.url` qui serait vide après bundling.
 */
const here = __dirname;
const devServerUrl = process.env.BOITIER_DEV_SERVER_URL;

// Identifiant d'application Windows (`appId` du paquet) : c'est lui qui
// rattache une notification à l'icône de l'application. S'il manque, Windows
// ignore la bulle sans le dire — l'application croit avoir prévenu.
try {
  app.setAppUserModelId('com.boitier.cloudmanager');
} catch {
  /* plateforme sans identifiant d'application : les bulles resteront muettes */
}

const windows: BrowserWindow[] = [];
let service: GoogleService | null = null;
let updater: Updater | null = null;
/** Service MEGA du lancement en cours : fermé proprement à la sortie. */
let megaService: MegaService | null = null;
let current: BrowserWindow | null = null;
/** Chemin du journal de démarrage, affiché dans les messages d'erreur. */
let logPath: string | null = null;
/** Dossier de données (coffre chiffré, journal), résolu avant `ready`. */
let dataDir: string | null = null;
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
    // Le journal est déjà ouvert par `boot.ts` : on ne le rouvre pas (cela
    // ferait tourner le fichier deux fois).
    logPath = currentLogPath() ?? initLog(dataDir);
  } catch {
    dataDir = null;
    logPath = null;
  }
  log(
    `démarrage ${app.getVersion()} · ${app.isPackaged ? 'installée' : 'développement'} · ` +
      `Electron ${process.versions.electron} · ${process.platform}`,
  );
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

/**
 * Notifications en cours d'affichage.
 *
 * Une `Notification` dont plus rien ne garde la référence peut être collectée
 * avant que Windows ne l'affiche : la bulle n'apparaît alors jamais, sans la
 * moindre erreur. On les conserve donc jusqu'à leur fermeture.
 */
const bulles = new Set<Notification>();

/**
 * Prévient le système qu'un transfert est terminé.
 *
 * Toujours, y compris quand la fenêtre est au premier plan : un transfert de
 * plusieurs minutes se termine rarement sous les yeux de l'utilisateur, et une
 * alerte qui dépend du focus est une alerte qui n'arrive pas. Seule
 * l'impossibilité technique (plateforme sans notification) la fait taire — et
 * c'est alors écrit dans le journal.
 */
function notifierTransfert(event: DownloadEvent): void {
  const nom = event.name?.trim() || 'Fichier';
  const reussi = event.status === 'done';
  const corps = reussi
    ? `Enregistré (${formatMo(event.size)})`
    : event.message ?? 'Le téléchargement a échoué.';

  if (!Notification.isSupported()) {
    log(`notification : non prise en charge par la plateforme (${nom})`);
    return;
  }

  try {
    const bulle = new Notification({
      title: reussi ? `Téléchargé : ${nom}` : `Échec : ${nom}`,
      body: corps,
      silent: false,
    });
    bulles.add(bulle);
    const oublier = () => bulles.delete(bulle);
    bulle.on('close', oublier);
    bulle.on('failed', (_evenement, erreur) => {
      oublier();
      log(`notification : refusée par Windows — ${erreur}`);
    });
    // Cliquer la bulle ramène la fenêtre : c'est ce qu'on attend d'une alerte.
    bulle.on('click', () => {
      oublier();
      const cible = windows.find((target) => !target.isDestroyed());
      if (!cible) return;
      if (cible.isMinimized()) cible.restore();
      if (!cible.isVisible()) cible.show();
      cible.focus();
    });
    bulle.show();
    log(`notification : ${reussi ? 'téléchargement terminé' : 'échec'} — ${nom}`);
  } catch (cause) {
    log(`notification impossible : ${(cause as Error).message}`);
  }
}

/** Taille lisible, sans dépendre du formateur de l'interface. */
function formatMo(octets: number): string {
  const mo = Math.max(0, Number(octets) || 0) / (1024 * 1024);
  if (mo >= 1024) return `${(mo / 1024).toFixed(1).replace('.', ',')} Go`;
  if (mo >= 1) return `${mo.toFixed(mo >= 10 ? 0 : 1).replace('.', ',')} Mo`;
  return `${Math.max(1, Math.round(mo * 1024))} Ko`;
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

  // Affichage garanti.
  //
  // `ready-to-show` ne se déclenche que si la page peint. Une page qui échoue
  // silencieusement laissait donc une fenêtre invisible : processus vivant,
  // aucun écran, aucune explication — exactement ce qu'on observe quand
  // « l'application ne s'ouvre pas ». Passé ce délai, on montre la fenêtre de
  // toute façon : au pire un fond clair, jamais rien.
  let shown = false;
  const show = (reason: string) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    log(`fenêtre affichée (${reason}) · +${sinceStart()} ms`);
  };
  // Le document est prêt bien avant que le bundle ait fini de s'exécuter :
  // l'écran de démarrage est du HTML et du CSS en ligne, peints sans attendre
  // le moindre fichier. On montre la fenêtre là, pas après le premier rendu de
  // l'interface — c'est plusieurs secondes d'écran vide en moins.
  win.webContents.on('dom-ready', () => {
    log(`document prêt · +${sinceStart()} ms`);
    show('écran de démarrage');
  });
  win.once('ready-to-show', () => show('prête à peindre'));
  setTimeout(() => show('délai d’affichage atteint'), 2500);
  win.once('closed', () => {
    shown = true;
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
      log(`interface prête · +${sinceStart()} ms`);
    }
    return true;
  });

  win.webContents.on('did-finish-load', () => {
    log(`document chargé · +${sinceStart()} ms`);
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

  win.webContents.on('did-start-loading', () => log(`chargement demandé · +${sinceStart()} ms`));
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
  // Sans fenêtre parente : si la fenêtre n'est jamais apparue, un dialogue
  // attaché à elle serait invisible lui aussi.
  const choice = dialog.showMessageBoxSync(options);
  if (choice === 0) {
    win.show();
    win.webContents.reload();
  } else {
    app.quit();
  }
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
  const choice = dialog.showMessageBoxSync(options);
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
  // En développement, les identifiants peuvent venir de .env.local.
  loadEnvFile();
  /**
   * État du chiffrement système au démarrage.
   *
   * C'est lui qui décide si le coffre est lisible : sans cette ligne, un poste
   * où `safeStorage` est momentanément indisponible donnerait un coffre vide
   * sans la moindre trace. Le coffre refuse désormais d'écrire dans ce cas, mais
   * il faut pouvoir le constater.
   */
  try {
    log(`chiffrement système : ${safeStorage.isEncryptionAvailable() ? 'disponible' : 'INDISPONIBLE'}`);
  } catch {
    log('chiffrement système : état illisible');
  }
  const config = readGoogleConfig();
  const vault = new Vault(dataDir ?? resolveDataDir(app.getPath('appData')), protect, unprotect);
  const win = createWindow();
  windows.push(win);
  current = win;

  service = new GoogleService({
    vault,
    userDataDir: app.getPath('userData'),
    openExternal: (url) => void shell.openExternal(url),
    // Tous les fichiers atterrissent dans `Téléchargements/BOITIER-CLOUD-MANAGER`
    // (puis `<cloud>/<nature>`) : ils ne se confondent plus avec le reste du
    // dossier Téléchargements.
    downloadsDir: async () => defaultDownloadDir(app.getPath('downloads')),
    emitDownload: (event) => {
      for (const target of windows) if (!target.isDestroyed()) emitDownload(target, event);
      // Notification système à la fin du transfert — et à la fin seulement.
      // Un appel par paquet saturerait le centre de notifications, donc une
      // seule alerte par transfert, sur un état terminal.
      if (event.status === 'done' || event.status === 'error') {
        notifierTransfert(event);
      }
    },
    endpoints: endpointsFromEnv(),
    ...(config.clientId ? { clientId: config.clientId } : {}),
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
  });

  // Une seule ligne par état réellement différent : la vérification est
  // annoncée deux fois (par nous et par la bibliothèque), et la progression
  // arrive par paquets. L'interface, elle, reçoit tout : c'est le journal qui
  // doit rester lisible.
  let derniereTrace = '';
  // L'interface n'a pas besoin de chaque point de progression : quatre par
  // seconde suffisent à une barre fluide, et un événement par paquet saturait
  // le canal IPC puis le rendu.
  let dernierEnvoi = 0;
  let dernierStatut = '';
  updater = new Updater((state) => {
    const trace = traceMiseAJour(state);
    if (trace !== derniereTrace) {
      derniereTrace = trace;
      log(trace);
    }
    const maintenant = Date.now();
    const changementDEtat = state.status !== dernierStatut;
    if (!changementDEtat && maintenant - dernierEnvoi < 250) return;
    dernierEnvoi = maintenant;
    dernierStatut = state.status;
    for (const target of windows) if (!target.isDestroyed()) emitUpdate(target, state);
  });
  // MEGA : coffre séparé (l'application ne mélange pas les fournisseurs) et
  // service propre. Les événements de transfert empruntent les mêmes canaux
  // que Drive : l'interface n'a qu'une seule file à afficher.
  const mega = new MegaService({
    session: new MegaSession(
      new MegaVault(dataDir ?? resolveDataDir(app.getPath('appData')), protect, unprotect),
    ),
    emitDownload: (event) => {
      for (const target of windows) if (!target.isDestroyed()) emitDownload(target, event);
      if (event.status === 'done' || event.status === 'error') notifierTransfert(event);
    },
    emitUpload: (event) => {
      for (const target of windows) if (!target.isDestroyed()) emitUpload(target, event);
      if (event.status === 'done' || event.status === 'error') {
        notifierTransfert({
          id: event.id,
          name: event.name,
          status: event.status,
          received: event.received,
          size: event.size,
          speed: 0,
          ...(event.message ? { message: event.message } : {}),
        });
      }
    },
    fallbackDir: async () => defaultDownloadDir(app.getPath('downloads')),
  });

  megaService = mega;
  registerIpc(win, service, updater, { session: mega.session, service: mega });
  // La vérification démarre douze secondes après : l'interface passe d'abord.
  updater.start();
  log(`fenêtre créée · +${sinceStart()} ms`);

  // Un clic sur l'icône a eu lieu pendant la préparation : on montre la
  // fenêtre sans attendre un second clic de l'utilisateur.
  if (revealPending) revealWindow();
}

// Le journal est ouvert avant le contrôle d'instance : une tentative de
// lancement refusée doit laisser une trace, sinon elle est indiagnostiquable.
/**
 * Attente avant de renoncer à ouvrir une fenêtre.
 *
 * L'installeur Windows ferme l'application avant de la remplacer, puis la
 * relance avec la case « Lancer » cochée. Si l'ancien processus met quelques
 * instants à mourir, le nouveau trouve le verrou d'instance encore pris et
 * sortait aussitôt : rien à l'écran, aucune explication. On réessaie donc
 * pendant quelques secondes avant de conclure qu'une autre fenêtre est ouverte.
 */
const LOCK_RETRY_DELAYS_MS = [400, 900, 1600, 2400, 3200];

async function acquireInstanceLock(): Promise<boolean> {
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    if (app.requestSingleInstanceLock()) {
      if (attempt) log(`verrou d’instance obtenu à la tentative ${attempt + 1}`);
      return true;
    }
    const delay = LOCK_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) break;
    log(`instance déjà ouverte (tentative ${attempt + 1}) : nouvelle tentative dans ${delay} ms`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return false;
}

/**
 * Séquence de lancement, écrite en `async` : le verrou d'instance peut demander
 * plusieurs tentatives (voir `acquireInstanceLock`).
 */
async function start(): Promise<void> {
  startLog();

  // Une seule instance : le serveur de boucle locale OAuth doit être unique.
  if (!(await acquireInstanceLock())) {
    log(
      'une instance est déjà ouverte : ce lancement s’arrête, la fenêtre existante est réutilisée',
    );
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    log('clic sur l’icône alors que l’application tourne déjà : retour à la fenêtre existante');
    revealWindow();
  });

  app.whenReady().then(boot);

  app.on('before-quit', () => {
    // Les sessions MEGA gardent des connexions ouvertes : on les ferme pour que
    // le processus se termine réellement, sans attendre l'expiration des délais.
    void megaService?.session.closeAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      log('fermeture : plus aucune fenêtre');
      updater?.stop();
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

void start();
