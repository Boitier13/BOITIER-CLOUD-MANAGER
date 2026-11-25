/**
 * Preload (CommonJS) : seul pont entre l'interface et le processus principal.
 * Le rendu n'obtient aucun accès à Node, au système de fichiers ou aux jetons.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('boitier', {
  platform: process.platform,
  /**
   * Signale au processus principal que l'interface est interactive.
   * Sans ce signal, la fenêtre peut afficher un cadre inerte (cas observé au
   * premier lancement après une mise à jour) : le processus principal recharge
   * alors une fois, puis prévient l'utilisateur.
   */
  ready: () => invoke('desktop:renderer-ready'),
  google: {
    status: () => invoke('google:status'),
    setClient: (clientId, clientSecret) => invoke('google:set-client', clientId, clientSecret),
    accounts: () => invoke('google:accounts'),
    connect: () => invoke('google:connect'),
    disconnect: (accountId) => invoke('google:disconnect', accountId),
    list: (accountId, folderId) => invoke('google:list', accountId, folderId),
    search: (accountId, term) => invoke('google:search', accountId, term),
    shared: (accountId) => invoke('google:shared', accountId),
    plan: (accountId, folderId) => invoke('google:plan', accountId, folderId),
    storage: (accountId) => invoke('google:storage', accountId),
    download: (request) => invoke('google:download', request),
    pause: (id) => invoke('google:pause', id),
    resume: (id, accountId) => invoke('google:resume', id, accountId),
    cancel: (id) => invoke('google:cancel', id),
    refresh: (accountId) => invoke('google:refresh', accountId),
    folder: () => invoke('google:folder'),
    openFolder: (path) => invoke('desktop:open-folder', path),
    openExternal: (url) => invoke('desktop:open-external', url),
    onDownload: (listener) => {
      const handler = (_event, payload) => {
        if (payload?.kind === 'download') listener(payload.event);
      };
      ipcRenderer.on('google:download-event', handler);
      return () => ipcRenderer.removeListener('google:download-event', handler);
    },
  },
});
