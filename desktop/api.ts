/**
 * Canaux IPC et enregistrement des gestionnaires.
 *
 * Le renderer ne reçoit que des métadonnées : jamais de jeton, jamais de secret.
 */

import { ipcMain, shell, type BrowserWindow } from 'electron';
import type { GoogleService } from './google/service.ts';
import type { DownloadEvent } from './google/downloads.ts';

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
  download: 'google:download',
  pause: 'google:pause',
  resume: 'google:resume',
  cancel: 'google:cancel',
  refresh: 'google:refresh',
  folder: 'google:folder',
  event: 'google:download-event',
  openExternal: 'desktop:open-external',
  openFolder: 'desktop:open-folder',
  /** Signal de vie : émis par l'interface dès qu'elle est interactive. */
  ready: 'desktop:renderer-ready',
} as const;

const CONSOLE_LINKS = /^https:\/\/(console\.cloud\.google\.com|developers\.google\.com)\//;

let registered = false;

export function registerIpc(_win: BrowserWindow, service: GoogleService): void {
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

  // Seuls les liens de configuration Google partent vers le navigateur.
  handle(channels.openExternal, async (url: string) => {
    const target = String(url);
    if (!CONSOLE_LINKS.test(target)) return false;
    await shell.openExternal(target);
    return true;
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
