/** Connexion Web isolée. Aucun mot de passe/cookie ne traverse le renderer. */
import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';

let active = false;
export async function loginTeraBox(parent?: BrowserWindow): Promise<string> {
  if (active) throw new Error('Une connexion TeraBox est déjà ouverte.');
  active = true;
  const partition = `terabox-login-${randomUUID()}`; // mémoire uniquement, jamais persist:...
  const isolated = session.fromPartition(partition);
  isolated.on('will-download', (event) => event.preventDefault());
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    width: 960, height: 760, minWidth: 520, minHeight: 500,
    title: 'TeraBox : connectez-vous puis fermez cette fenêtre',
    autoHideMenuBar: true,
    webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.removeMenu();
  const secure = (url: string): boolean => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };
  const protectWindow = (child: BrowserWindow) => {
    child.webContents.on('will-navigate', (event, url) => { if (!secure(url)) event.preventDefault(); });
    child.webContents.on('will-redirect', (event, url) => { if (!secure(url)) event.preventDefault(); });
    child.webContents.on('did-create-window', (popup) => protectWindow(popup));
    child.webContents.setWindowOpenHandler(({ url }) => secure(url) ? {
      action: 'allow',
      overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } },
    } : { action: 'deny' });
  };
  protectWindow(window);
  window.webContents.on('page-title-updated', (event) => { event.preventDefault(); });
  const closed = new Promise<void>((resolve) => window.once('closed', resolve));
  try {
    void window.loadURL('https://www.terabox.com/main').catch(() => undefined);
    await closed;
    const cookies = await isolated.cookies.get({ url: 'https://www.terabox.com/', name: 'ndus' });
    const cookie = cookies.find((c) => c.name === 'ndus' && c.value && (c.domain === 'terabox.com' || c.domain === '.terabox.com' || c.domain === 'www.terabox.com' || c.domain === '.www.terabox.com'));
    if (!cookie) throw new Error('Connexion TeraBox non terminée : connectez-vous sur le site avant de fermer la fenêtre.');
    return cookie.value;
  } finally {
    for (const child of BrowserWindow.getAllWindows()) if (child.webContents.session === isolated && !child.isDestroyed()) child.destroy();
    await isolated.clearStorageData().catch(() => undefined);
    await isolated.clearCache().catch(() => undefined);
    active = false;
  }
}
