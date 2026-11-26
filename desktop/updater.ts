/**
 * Mises à jour automatiques.
 *
 * L'application vérifie elle-même, une fois par démarrage et toutes les six
 * heures, si une version plus récente est publiée sur GitHub. Le téléchargement
 * se fait en arrière-plan ; **l'installation n'a jamais lieu sans un clic** :
 * `autoInstallOnAppQuit` est désactivé, sinon fermer la fenêtre installerait
 * une version que personne n'a demandée.
 *
 * Le fichier `latest.yml`, publié avec l'installeur, décrit la version
 * disponible et son empreinte : la mise à jour ne peut pas être substituée par
 * un autre fichier sans être détectée.
 *
 * Rien de tout cela ne s'exécute dans une copie de développement : sans
 * installation, il n'y a ni `app-update.yml` ni version à remplacer.
 */

import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

export type UpdateStatus =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
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

    // L'installation attend un clic : fermer l'application ne doit jamais
    // changer de version à l'insu de l'utilisateur.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
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
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.timer = setInterval(() => void this.check(), PERIOD_MS);
    // Un minuteur ne doit pas retenir l'application ouverte.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Vérification manuelle (bouton des paramètres) ou périodique. */
  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.snapshot();
    if (this.state.status === 'downloading' || this.state.status === 'ready') {
      return this.snapshot();
    }
    this.update({ status: 'checking', message: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (cause) {
      this.update({ status: 'error', message: prettify(cause as Error) });
    }
    return this.snapshot();
  }

  /**
   * Installe la version téléchargée et relance l'application.
   *
   * L'installeur reste visible : sans signature de code, une installation
   * silencieuse serait un saut dans le vide. L'utilisateur voit ainsi ce qui
   * se passe, et l'assistant NSIS se comporte comme lors d'une installation
   * habituelle.
   */
  install(): boolean {
    if (this.state.status !== 'ready') return false;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
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
