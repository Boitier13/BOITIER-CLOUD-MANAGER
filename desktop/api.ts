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
import type { MegaService, UploadEvent } from './mega/service.ts';
import type { MegaSession } from './mega/session.ts';
import { log, logPath, sinceStart } from './log.ts';

export const channels = {
  status: 'google:status',
  setClient: 'google:set-client',
  accounts: 'google:accounts',
  report: 'google:report',
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
  note: 'desktop:note',
  /** Repère de temps du démarrage, vu depuis l'interface. */
  timing: 'desktop:timing',
  /** Ouvre le journal de démarrage dans l'éditeur du système. */
  openLog: 'desktop:open-log',
  /* MEGA : session séparée, mêmes formes de données que Drive. */
  megaAccounts: 'mega:accounts',
  megaConnect: 'mega:connect',
  megaDisconnect: 'mega:disconnect',
  megaList: 'mega:list',
  megaSearch: 'mega:search',
  megaRecent: 'mega:recent',
  megaUsage: 'mega:usage',
  megaPlan: 'mega:plan',
  megaDownload: 'mega:download',
  megaPause: 'mega:pause',
  megaResume: 'mega:resume',
  megaCancel: 'mega:cancel',
  /** Ouvre la boîte de dialogue puis téléverse dans le dossier courant. */
  megaUpload: 'mega:upload',
  megaUploadEvent: 'mega:upload-event',
  /** Mises à jour : état, vérification, installation. */
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateEvent: 'update:event',
} as const;



let registered = false;

export function registerIpc(
  _win: BrowserWindow,
  service: GoogleService,
  updater: Updater,
  mega?: { session: MegaSession; service: MegaService },
): void {
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
  handle(channels.report, () => service.report());
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

  /* ------------------------------------------------------------------------
   * MEGA
   * ---------------------------------------------------------------------- */

  if (mega) {
    handle(channels.megaAccounts, () => mega.session.accounts());
    handle(
      channels.megaConnect,
      (email: string, password: string, secondFactor?: string) =>
        mega.session.connect(String(email ?? ''), String(password ?? ''), secondFactor ? String(secondFactor) : undefined),
    );
    handle(channels.megaDisconnect, (accountId: string) =>
      mega.session.disconnect(String(accountId)),
    );
    handle(channels.megaList, (accountId: string, folderId: string) =>
      mega.service.list(String(accountId), String(folderId ?? '')),
    );
    handle(channels.megaSearch, (accountId: string, term: string) =>
      mega.service.search(String(accountId), String(term ?? '')),
    );
    handle(channels.megaRecent, (accountId: string, limit?: number) =>
      mega.service.recent(String(accountId), Number(limit) || 200),
    );
    handle(channels.megaUsage, (accountId: string) => mega.service.usage(String(accountId)));
    handle(channels.megaPlan, (accountId: string, folderId: string) =>
      mega.service.plan(String(accountId), String(folderId ?? '')),
    );
    handle(
      channels.megaDownload,
      (request: {
        id: string;
        accountId: string;
        fileId: string;
        name: string;
        size: number;
        dir?: string;
        subPath?: string;
      }) => mega.service.start({ ...request, dir: request.dir ?? '' }),
    );
    handle(channels.megaPause, (id: string) => mega.service.pause(String(id)));
    handle(channels.megaResume, (id: string) => mega.service.resume(String(id)));
    handle(channels.megaCancel, (id: string) => mega.service.cancel(String(id)));

    /**
     * Téléversement : le fichier est choisi par la boîte de dialogue du
     * système, puis lu et envoyé par le processus principal. L'interface ne
     * touche jamais au disque, et n'obtient aucun chemin au-delà du nom.
     */
    handle(channels.megaUpload, async (accountId: string, folderId: string) => {
      const options = {
        title: 'Fichier à envoyer sur MEGA',
        properties: ['openFile', 'multiSelections'] as const,
      };
      const resultat = _win
        ? await dialog.showOpenDialog(_win, { ...options, properties: [...options.properties] })
        : await dialog.showOpenDialog({ ...options, properties: [...options.properties] });
      if (resultat.canceled || !resultat.filePaths.length) return { sent: 0 };
      for (const chemin of resultat.filePaths) {
        await mega.service.upload(String(accountId), String(folderId ?? ''), chemin);
      }
      return { sent: resultat.filePaths.length };
    });
  }

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

  // Notes de l'interface vers le journal.
  //
  // Une synchronisation qui échoue était invisible : le compte manquait à
  // l'écran sans la moindre trace, et il fallait deviner. Ces quelques lignes
  // rendent l'échec lisible. Elles sont bornées : un journal illisible ne sert
  // à rien.
  let notesEmises = 0;
  ipcMain.on(channels.note, (_event, message: unknown) => {
    if (notesEmises >= 40) return;
    const texte = String(message ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 160)
      .trim();
    if (!texte) return;
    notesEmises += 1;
    log(`interface : ${texte}`);
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

/** Diffuse la progression d'un téléversement MEGA vers la fenêtre. */
export function emitUpload(win: BrowserWindow, event: UploadEvent): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channels.megaUploadEvent, event);
}

/** Diffuse l'état des mises à jour vers la fenêtre. */
export function emitUpdate(win: BrowserWindow, state: UpdateState): void {
  if (win.isDestroyed()) return;
  win.webContents.send(channels.updateEvent, state);
}
