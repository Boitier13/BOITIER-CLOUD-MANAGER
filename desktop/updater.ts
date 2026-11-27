/**
 * Mises à jour automatiques.
 *
 * L'application vérifie elle-même, une fois par démarrage et toutes les six
 * heures, si une version plus récente est publiée sur GitHub. **Rien n'est
 * téléchargé sans un clic** : ni l'installation, ni même le téléchargement.
 *
 * Ce n'était pas le cas, et cela coûtait cher : l'installeur fait près de
 * 100 Mo, et `electron-updater` le téléchargeait dès qu'une version était
 * trouvée, puis en vérifiait l'empreinte — sur le fil du processus principal.
 * Sur une machine modeste, cela se voyait : « figement 7,6 s · écran settings »
 * pendant que l'utilisateur consultait simplement les paramètres, et des
 * blocages de plusieurs secondes à chaque étape. Le bouton « Télécharger la
 * mise à jour » existe donc, et il faut le vouloir.
 *
 * Le fichier `latest.yml`, publié avec l'installeur, décrit la version
 * disponible et son empreinte : un fichier qui ne correspond pas au manifeste
 * est rejeté. Cela ne remplace pas une signature de l'éditeur.
 *
 * Rien de tout cela ne s'exécute dans une copie de développement : sans
 * installation, il n'y a ni `app-update.yml` ni version à remplacer.
 */

import { app } from 'electron';
import { join } from 'node:path';
import { launchDetached } from './update-launcher.ts';
import { log } from './log.ts';

/**
 * La bibliothèque de mise à jour est chargée **tardivement**, et son échec ne
 * peut pas empêcher l'application de démarrer.
 *
 * Une dépendance qui lève à l'import arrêtait tout le processus avant même la
 * première ligne de journal : la fenêtre ne s'ouvrait jamais, sans explication.
 * Ici, un échec devient un état lisible dans les paramètres, pas un écran vide.
 */
type AutoUpdater = typeof import('electron-updater').autoUpdater;

async function loadAutoUpdater(): Promise<AutoUpdater | null> {
  try {
    const module = await import('electron-updater');
    return module.autoUpdater ?? null;
  } catch (cause) {
    log(`mise à jour indisponible : ${(cause as Error).message}`);
    return null;
  }
}

export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  /** Version installée, toujours connue. */
  currentVersion: string;
  /** Version trouvée, quand il y en a une. */
  version?: string;
  /** Avancement du téléchargement, 0 à 100. */
  percent?: number;
  /** Explication lisible quand quelque chose empêche la mise à jour. */
  message?: string;
  /** Date de la dernière vérification aboutie. */
  checkedAt?: string;
}

/** Vérification au démarrage : après l'interface, jamais devant elle. */
const FIRST_CHECK_DELAY_MS = 12_000;
/** Puis toutes les six heures, tant que la fenêtre reste ouverte. */
const PERIOD_MS = 6 * 60 * 60 * 1000;

export class Updater {
  private state: UpdateState;
  private timer: NodeJS.Timeout | null = null;
  private wired = false;
  private updater: AutoUpdater | null = null;
  private downloadedFile: string | null = null;
  private adminRequired = false;
  private readonly notify: (state: UpdateState) => void;

  constructor(notify: (state: UpdateState) => void) {
    this.notify = notify;
    this.state = {
      status: app.isPackaged ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      ...(app.isPackaged
        ? {}
        : { message: 'Mises à jour disponibles dans la version installée uniquement.' }),
    };
  }

  snapshot(): UpdateState {
    return { ...this.state };
  }

  private update(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.notify(this.snapshot());
  }

  /** Branche les événements du moteur et lance la première vérification. */
  start(): void {
    if (!app.isPackaged || this.wired) return;
    this.wired = true;
    void this.wire();
  }

  private async wire(): Promise<void> {
    const autoUpdater = await loadAutoUpdater();
    if (!autoUpdater) {
      this.update({
        status: 'unsupported',
        message: 'Mécanisme de mise à jour indisponible dans cette copie.',
      });
      return;
    }
    this.updater = autoUpdater;

    // Deux clics, deux intentions distinctes : télécharger, puis installer.
    // Fermer l'application ne doit jamais changer de version à l'insu de
    // l'utilisateur, et le téléchargement d'un installeur de 100 Mo ne doit pas
    // se déclencher pendant qu'il travaille.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Le lanceur utilise uniquement les installeurs complets NSIS.
    autoUpdater.disableWebInstaller = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => {
      this.update({ status: 'checking', message: undefined });
    });

    autoUpdater.on('update-available', (info) => {
      this.update({ status: 'available', version: info.version, message: undefined });
    });

    autoUpdater.on('update-not-available', () => {
      this.update({ status: 'idle', message: undefined, checkedAt: new Date().toISOString() });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.update({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.downloadedFile = info.downloadedFile;
      this.adminRequired = info.files?.some((file) => file.isAdminRightsRequired === true) ?? false;
      this.update({
        status: 'ready',
        version: info.version,
        percent: 100,
        checkedAt: new Date().toISOString(),
      });
    });

    autoUpdater.on('error', (cause: Error) => {
      // Un réseau absent n'est pas une panne : on le dit sans dramatiser.
      const message = prettify(cause);
      this.update({ status: 'error', message });
    });

    this.schedule();
  }

  private schedule(): void {
    log(`mise à jour : première vérification dans ${Math.round(FIRST_CHECK_DELAY_MS / 1000)} s`);
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), PERIOD_MS);
    // Un minuteur ne doit pas retenir l'application ouverte.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Vérification manuelle (bouton des paramètres) ou périodique. */
  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.snapshot();
    if (this.state.status === 'downloading' || this.state.status === 'ready' || this.state.status === 'installing') {
      return this.snapshot();
    }
    const autoUpdater = this.updater ?? (await loadAutoUpdater());
    this.updater = autoUpdater;
    if (!autoUpdater) {
      this.update({
        status: 'unsupported',
        message: 'Mécanisme de mise à jour indisponible dans cette copie.',
      });
      return this.snapshot();
    }
    log('mise à jour : vérification demandée');
    this.update({ status: 'checking', message: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (cause) {
      this.update({ status: 'error', message: prettify(cause as Error) });
    }
    return this.snapshot();
  }

  /**
   * Télécharge la version disponible, sur demande explicite.
   *
   * Renvoie l'état à la fin : `ready` si le fichier est complet, sinon l'état
   * courant (erreur comprise), pour que l'écran ne reste pas sur « 0 % ».
   */
  async download(): Promise<UpdateState> {
    const autoUpdater = this.updater ?? (await loadAutoUpdater());
    this.updater = autoUpdater;
    if (!autoUpdater) return this.snapshot();
    if (this.state.status === 'downloading' || this.state.status === 'ready' || this.state.status === 'installing') {
      return this.snapshot();
    }
    if (this.state.status !== 'available') {
      // Aucun contrôle frais : on en refait un, le bouton reste utile.
      const frais = await this.check();
      if (frais.status !== 'available') return frais;
    }
    log(`mise à jour : téléchargement demandé ${this.state.version ?? ''}`.trim());
    this.update({ status: 'downloading', percent: 0, message: undefined });
    try {
      await autoUpdater.downloadUpdate();
    } catch (cause) {
      log(`mise à jour : téléchargement impossible — ${(cause as Error).message}`);
      this.update({
        status: 'error',
        message: prettify(cause as Error),
      });
    }
    return this.snapshot();
  }

  /** Installe uniquement après clic, sans bloquer le processus principal. */
  install(): boolean {
    if (this.state.status !== 'ready' || !this.updater || !this.downloadedFile) {
      log(`mise à jour : installation refusée (${this.state.status})`);
      return false;
    }
    const installer = this.downloadedFile;
    log(`mise à jour : installation demandée ${this.state.version ?? ''}`.trim());
    this.update({ status: 'installing', message: undefined });
    // Équivalent NSIS à quitAndInstall(false, true) pour nos installeurs complets.
    // Pas de shell : les espaces et caractères spéciaux du chemin restent intacts.
    void launchDetached({
      command: installer,
      args: ['--updated', '--force-run'],
      elevationPath: join(process.resourcesPath, 'elevate.exe'),
      adminRequired: this.adminRequired,
    }).then(() => {
      log('mise à jour : installeur démarré, fermeture demandée');
      app.quit();
    }).catch((cause: Error) => {
      log(`mise à jour : installeur impossible — ${cause.message}`);
      this.update({
        status: 'ready',
        message: 'L’installeur n’a pas pu être lancé. La version téléchargée reste disponible ; vous pouvez réessayer.',
      });
    });
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Ligne de journal décrivant un état, **sans doublon ni bavardage**.
 *
 * Deux sources annoncent la même vérification (notre propre `check()` et
 * l'événement `checking-for-update` de la bibliothèque) : le journal écrivait
 * donc deux fois la même ligne à la même milliseconde. Et la progression était
 * écrite à chaque paquet — des centaines de lignes sur une connexion lente, qui
 * finissaient par effacer l'historique des démarrages lors de la rotation.
 *
 * D'où un palier de 10 % : dix lignes au maximum pour un téléchargement, et une
 * seule par état réellement différent.
 */
export function traceMiseAJour(state: UpdateState): string {
  const tete = `mise à jour : ${state.status}${state.version ? ` ${state.version}` : ''}`;
  const explication = state.message ? ` (${state.message})` : '';
  if (state.status === 'downloading') {
    const borne = Math.max(0, Math.min(100, state.percent ?? 0));
    const palier = Math.floor(borne / 10) * 10;
    return `${tete} ${palier} %${explication}`;
  }
  return `${tete}${explication}`;
}

/** Traduit les erreurs du moteur en une phrase utilisable. */
function prettify(cause: Error): string {
  const raw = String(cause?.message ?? cause ?? '').trim();
  if (/net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONN|network/i.test(raw)) {
    return 'Pas de connexion : la vérification reprendra plus tard.';
  }
  if (/404|latest\.yml/i.test(raw)) {
    return 'Aucune mise à jour publiée pour l’instant.';
  }
  if (/ENOENT|app-update\.yml/i.test(raw)) {
    return 'Mise à jour indisponible dans cette copie de l’application.';
  }
  if (/signature|ERR_UPDATER_INVALID_SIGNATURE/i.test(raw)) {
    return 'La mise à jour téléchargée n’a pas la signature attendue : elle a été écartée.';
  }
  return raw || 'Vérification impossible pour le moment.';
}
