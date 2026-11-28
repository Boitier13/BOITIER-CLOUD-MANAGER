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
  /**
   * Mises à jour : lecture d'état, vérification à la demande, installation.
   * L'installation n'est possible qu'après un téléchargement complet — le
   * processus principal refuse tout le reste.
   */
  updater: {
    state: () => invoke('update:state'),
    check: () => invoke('update:check'),
    // Le téléchargement est une intention distincte de l'installation.
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    onChange: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on('update:event', handler);
      return () => ipcRenderer.removeListener('update:event', handler);
    },
  },
  setZoom: (factor) => invoke('desktop:set-zoom', factor),
  /**
   * Signale un figement de l'interface, en millisecondes. Purement
   * diagnostique : le processus principal l'écrit dans le journal de démarrage.
   */
  reportFreeze: (retard, contexte) => ipcRenderer.send('desktop:freeze', retard, contexte),
  /** Repère de temps (démarrage) : écrit dans le journal par le processus principal. */
  reportTiming: (libelle) => ipcRenderer.send('desktop:timing', libelle),
  /** Aller-retour minimal : l'interface mesure la réactivité du processus principal. */
  ping: () => invoke('desktop:ping'),
  note: (message) => ipcRenderer.send('desktop:note', message),
  /** Ouvre le journal de démarrage : plus besoin de retrouver le chemin à la main. */
  openLog: () => invoke('desktop:open-log'),
  google: {
    status: () => invoke('google:status'),
    setClient: (clientId, clientSecret) => invoke('google:set-client', clientId, clientSecret),
    accounts: () => invoke('google:accounts'),
    report: () => invoke('google:report'),
    connect: () => invoke('google:connect'),
    disconnect: (accountId) => invoke('google:disconnect', accountId),
    list: (accountId, folderId) => invoke('google:list', accountId, folderId),
    search: (accountId, term) => invoke('google:search', accountId, term),
    shared: (accountId) => invoke('google:shared', accountId),
    plan: (accountId, folderId) => invoke('google:plan', accountId, folderId),
    storage: (accountId) => invoke('google:storage', accountId),
    recent: (accountId, options) => invoke('google:recent', accountId, options),
    download: (request) => invoke('google:download', request),
    pause: (id) => invoke('google:pause', id),
    resume: (id, accountId) => invoke('google:resume', id, accountId),
    cancel: (id) => invoke('google:cancel', id),
    refresh: (accountId) => invoke('google:refresh', accountId),
    folder: () => invoke('google:folder'),
    locate: (accountId, fileId) => invoke('google:locate', accountId, fileId),
    chooseFolder: () => invoke('desktop:choose-folder'),
    openFolder: (path) => invoke('desktop:open-folder', path),
    openDirectory: (path) => invoke('desktop:open-directory', path),
    openExternal: (url) => invoke('desktop:open-external', url),
    onDownload: (listener) => {
      const handler = (_event, payload) => {
        if (payload?.kind === 'download') listener(payload.event);
      };
      ipcRenderer.on('google:download-event', handler);
      return () => ipcRenderer.removeListener('google:download-event', handler);
    },
  },
  /**
   * MEGA. Même forme de données que Google côté fichiers, mais une session
   * distincte : MEGA n'a pas d'OAuth, l'ouverture se fait par adresse et mot de
   * passe, et le mot de passe n'est jamais conservé.
   */
  terabox: {
    accounts: () => invoke('terabox:accounts'),
    connect: (name, expectedId) => invoke('terabox:connect', name, expectedId),
    disconnect: (id) => invoke('terabox:disconnect', id),
    list: (id, folder) => invoke('terabox:list', id, folder),
    locate: (id, file) => invoke('terabox:locate', id, file),
    search: (id, term) => invoke('terabox:search', id, term),
    recent: (id, limit) => invoke('terabox:recent', id, limit),
    usage: (id) => invoke('terabox:usage', id),
    plan: (id, folder) => invoke('terabox:plan', id, folder),
    prepareFolders: (base, paths) => invoke('terabox:prepare-folders', base, paths),
    download: (request) => invoke('terabox:download', request),
    pause: (id) => invoke('terabox:pause', id),
    resume: (id) => invoke('terabox:resume', id),
    cancel: (id) => invoke('terabox:cancel', id),
  },
  shadow: {
    accounts: () => invoke('shadow:accounts'),
    connect: (username, token, url, expectedId) => invoke('shadow:connect', username, token, url, expectedId),
    disconnect: (id) => invoke('shadow:disconnect', id),
    list: (id, folder) => invoke('shadow:list', id, folder),
    locate: (id, file) => invoke('shadow:locate', id, file),
    search: (id, term) => invoke('shadow:search', id, term),
    recent: (id, limit) => invoke('shadow:recent', id, limit),
    usage: (id) => invoke('shadow:usage', id),
    plan: (id, folder) => invoke('shadow:plan', id, folder),
    prepareFolders: (base, paths) => invoke('shadow:prepare-folders', base, paths),
    download: (request) => invoke('shadow:download', request),
    pause: (id) => invoke('shadow:pause', id),
    resume: (id) => invoke('shadow:resume', id),
    cancel: (id) => invoke('shadow:cancel', id),
  },
  mega: {
    accounts: () => invoke('mega:accounts'),
    connect: (email, password, secondFactor) =>
      invoke('mega:connect', email, password, secondFactor),
    disconnect: (accountId) => invoke('mega:disconnect', accountId),
    list: (accountId, folderId) => invoke('mega:list', accountId, folderId),
    search: (accountId, term) => invoke('mega:search', accountId, term),
    recent: (accountId, limit) => invoke('mega:recent', accountId, limit),
    usage: (accountId) => invoke('mega:usage', accountId),
    plan: (accountId, folderId) => invoke('mega:plan', accountId, folderId),
    download: (request) => invoke('mega:download', request),
    pause: (id) => invoke('mega:pause', id),
    resume: (id) => invoke('mega:resume', id),
    cancel: (id) => invoke('mega:cancel', id),
    /** Ouvre la boîte de dialogue du système, puis téléverse les fichiers choisis. */
    upload: (accountId, folderId) => invoke('mega:upload', accountId, folderId),
    onUpload: (listener) => {
      const handler = (_event, event) => listener(event);
      ipcRenderer.on('mega:upload-event', handler);
      return () => ipcRenderer.removeListener('mega:upload-event', handler);
    },
  },
});
