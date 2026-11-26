/**
 * Canaux IPC et enregistrement des gestionnaires.
 *
 * Le renderer ne reçoit que des métadonnées : jamais de jeton, jamais de secret.
 */

import { ipcMain, shell, type BrowserWindow, dialog } from 'electron';
import type { GoogleService } from './google/service.ts';
import { isAllowedExternalUrl } from '../src/lib/driveLinks.ts';
import type { DownloadEvent } from './google/downloads.ts';
import type { UpdateState, Updater } from './updater.ts';
import { log, logPath, sinceStart } from './log.ts';

export const channels = {
  status: 'google:status',
  setClient: 'google:set-client',
  accounts: 'google:accounts',
  connect: 'google:connect',
  disconnect: 'google:disconnect',
  list: 'google:list',
  search: 'google:search',
  shared: 'google:shared',
  plan: 'google:plan',
  storage: 'google:storage',
  recent: 'google:recent',
  download: 'google:download',
  pause: 'google:pause',
  resume: 'google:resume',
  cancel: 'google:cancel',
  refresh: 'google:refresh',
  folder: 'google:folder',
  /** Chemin d'un élément (recherche multi-comptes → dossier d'origine). */
  locate: 'google:locate',
  chooseFolder: 'desktop:choose-folder',
  event: 'google:download-event',
  openExternal: 'desktop:open-external',
  openFolder: 'desktop:open-folder',
  openDirectory: 'desktop:open-directory',
  /** Signal de vie : émis par l'interface dès qu'elle est interactive. */
  ready: 'desktop:renderer-ready',
  /** Facteur de zoom de la fenêtre (taille du texte choisie). */
  setZoom: 'desktop:set-zoom',
  /**
   * Signalement d'un figement (millisecondes perdues + contexte).
   * L'interface ne peut pas écrire dans le journal : elle le dit ici.
   */
  freeze: 'desktop:freeze',
  /** Aller-retour minimal : mesure la réactivité du processus principal. */
  ping: 'desktop:ping',
  /** Repère de temps du démarrage, vu depuis l'interface. */
  timing: 'desktop:timing',
  /** Ouvre le journal de démarrage dans l'éditeur du système. */
  openLog: 'desktop:open-log',
  /** Mises à jour : état, vérification, installation. */
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateEvent: 'update:event',
} as const;



let registered = false;

export function registerIpc(_win: BrowserWindow, service: GoogleService, updater: Updater): void {
  // Une seule instance : les gestionnaires ne sont enregistrés qu'une fois,
  // même si la fenêtre est recréée.
  if (registered) return;
  registered = true;

  const handle = <T>(
    channel: string,
    fn: (...args: never[]) => Promise<T> | T,
  ): void => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
  };

  handle(channels.status, () => service.clientStatus());
  handle(channels.setClient, (clientId: string, clientSecret: string) =>
    service.setClient({
      clientId: String(clientId ?? '').trim(),
      ...(String(clientSecret ?? '').trim()
        ? { clientSecret: String(clientSecret).trim() }
        : {}),
    }),
  );
  handle(channels.accounts, () => service.accounts());
  handle(channels.connect, () => service.connect());
  handle(channels.disconnect, (accountId: string) => service.disconnect(String(accountId)));
  handle(channels.list, (accountId: string, folderId: string) =>
    service.list(String(accountId), String(folderId)),
  );
  handle(channels.search, (accountId: string, term: string) =>
    service.search(String(accountId), String(term)),
  );
  handle(channels.shared, (accountId: string) => service.shared(String(accountId)));
  handle(channels.plan, (accountId: string, folderId: string) =>
    service.plan(String(accountId), String(folderId)),
  );
  handle(channels.storage, (accountId: string) => service.storage(String(accountId)));
  handle(channels.recent, (accountId: string, options?: { days?: number; limit?: number }) =>
    service.recent(String(accountId), options ?? {}),
  );
  handle(
    channels.download,
    (request: {
      id: string;
      accountId: string;
      fileId: string;
      name: string;
      size: number;
      dir?: string;
      subPath?: string;
    }) => service.download(request),
  );
  handle(channels.pause, (id: string) => service.pause(String(id)));
  handle(channels.resume, (id: string, accountId: string) =>
    service.resume(String(id), String(accountId)),
  );
  handle(channels.cancel, (id: string) => service.cancel(String(id)));
  handle(channels.refresh, (accountId: string) => service.refresh(String(accountId)));
  handle(channels.folder, () => service.downloadsFolder());
  handle(channels.locate, (accountId: string, fileId: string) =>
    service.locate(accountId, fileId),
  );

  // Mises à jour. `state` est une lecture sans effet de bord ; `check` et
  // `install` sont les deux seules actions, et l'installation exige qu'une
  // version ait été préalablement téléchargée.
  // Figement signalé par l'interface : une ligne de journal, pas de correction.
  // Le contexte (écran, processus principal) évite d'avoir à deviner d'où vient
  // le blocage quand il n'existe aucun moyen de reproduire sur une autre machine.
  ipcMain.on(channels.freeze, (_event, retard: number, contexte?: string) => {
    const perdu = Math.round(Number(retard) || 0);
    if (perdu < 400) return;
    const ou = typeof contexte === 'string' && contexte.trim() ? ` — ${contexte}` : '';
    log(`figement ${(perdu / 1000).toFixed(1)} s${ou}`);
  });

  // Repères de démarrage vus depuis l'interface : bundle exécuté, premier
  // rendu, polices prêtes, peinture. Sans eux, « c'est lent au démarrage » ne
  // se découpe en rien et on corrige à l'aveugle.
  ipcMain.on(channels.timing, (_event, libelle: unknown) => {
    const texte = String(libelle ?? '').slice(0, 80).trim();
    if (!texte) return;
    log(`interface : ${texte} · +${sinceStart()} ms`);
  });

  // Réactivité du processus principal : l'interface mesure l'aller-retour.
  handle(channels.ping, () => true);

  handle(channels.openLog, async () => {
    const chemin = logPath();
    if (!chemin) return null;
    await shell.openPath(chemin);
    return chemin;
  });

  handle(channels.updateState, () => updater.snapshot());
  handle(channels.updateCheck, () => updater.check());
  handle(channels.updateInstall, () => updater.install());

  /**
   * Choix du dossier de destination par la boîte de dialogue du système.
   *
   * La liste de dossiers était écrite en dur dans l'interface (`D:\Médias\…`),
   * chemins inventés qui ne valaient pour aucune machine.
   */
  handle(channels.chooseFolder, async () => {
    const current = await service.downloadsFolder().catch(() => '');
    const options = {
      title: 'Dossier de destination des téléchargements',
      properties: ['openDirectory', 'createDirectory'] as const,
      ...(current ? { defaultPath: current } : {}),
    };
    const result = _win
      ? await dialog.showOpenDialog(_win, { ...options, properties: [...options.properties] })
      : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  // Seuls les liens de configuration Google et de Google Drive partent vers le
  // navigateur. Tout le reste est refusé.
  handle(channels.openExternal, async (url: string) => {
    const target = String(url);
    if (!isAllowedExternalUrl(target)) return false;
    await shell.openExternal(target);
    return true;
  });
  // Ouvre un dossier dans l'explorateur (pas seulement le sélectionner).
  // Taille du texte : zoom natif de la fenêtre, conservé par l'interface.
  handle(channels.setZoom, (factor: number) => {
    if (!_win) return false;
    const value = Math.min(2, Math.max(0.8, Number(factor) || 1));
    _win.webContents.setZoomFactor(value);
    return true;
  });

  handle(channels.openDirectory, async (path: string) => {
    const target = String(path ?? '').trim();
    if (!target) return false;
    const failure = await shell.openPath(target);
    return failure === '';
  });
  handle(channels.openFolder, async (path: string) => {
    const target = String(path);
    if (target) await shell.showItemInFolder(target);
  });

}

/** Diffuse un événement de transfert vers l'interface. */
export function emitDownload(win: BrowserWindow, event: DownloadEvent): void {
  win.webContents.send(channels.event, { kind: 'download', event });
}

/** Diffuse l'état des mises à jour vers la fenêtre. */
export function emitUpdate(win: BrowserWindow, state: UpdateState): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channels.updateEvent, state);
}
