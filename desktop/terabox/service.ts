/** Façade lecture seule, indépendante du protocole Web non officiel. */
import { TeraBoxVault, type TeraBoxStoredAccount } from './vault.ts';
import { TeraBoxWebClient } from './web-client.ts';
import type { TeraBoxEntry, TeraBoxReader, WebReaderFactory } from './provider.ts';
import { mkdir } from 'node:fs/promises';
import { DownloadManager, relativeDir, type DownloadEvent } from '../google/downloads.ts';
import type { FolderPlan } from '../google/tree.ts';
import { mimeFromName, sortRemoteFiles, type RemoteFile } from '../mega/files.ts';

function publicAccount(account: TeraBoxStoredAccount) {
  return { accountId: account.id, name: account.name, usedBytes: account.usedBytes, quotaBytes: account.quotaBytes, status: 'connected' as const };
}
function pathId(path: string): string { return `tb_${Buffer.from(path).toString('base64url')}`; }
function decodePath(id: string): string {
  if (!id || id === 'root') return '/';
  if (!/^tb_[A-Za-z0-9_-]{1,6000}$/.test(id)) throw new Error('Identifiant TeraBox invalide.');
  const path = Buffer.from(id.slice(3), 'base64url').toString('utf8');
  if (pathId(path) !== id || !path.startsWith('/') || path.split('/').some((s) => s === '.' || s === '..') || path.includes('\0')) throw new Error('Chemin TeraBox invalide.');
  return path;
}
function toFile(f: TeraBoxEntry): RemoteFile {
  return { id: pathId(f.path), name: f.name, kind: f.directory ? 'folder' : 'file', size: f.size, modified: f.modified, mimeType: f.directory ? 'terabox/folder' : mimeFromName(f.name) };
}
export class TeraBoxService {
  private readonly vault: TeraBoxVault;
  private readonly createWebReader: WebReaderFactory;
  private readonly transfers?: DownloadManager;
  private readonly fallbackDir?: () => Promise<string>;
  private readonly transferAccounts = new Map<string, string>();
  constructor(vault: TeraBoxVault, transport: typeof fetch = fetch, createWebReader?: WebReaderFactory,
    transferOptions?: { emit: (event: DownloadEvent) => void; fallbackDir: () => Promise<string> }) {
    this.vault = vault;
    this.createWebReader = createWebReader ?? ((session) => new TeraBoxWebClient(session, transport));
    this.fallbackDir = transferOptions?.fallbackDir;
    if (transferOptions) {
      this.transfers = new DownloadManager({ drive: '' } as never, (event) => {
        if (event.status === 'done') this.transferAccounts.delete(event.id);
        transferOptions.emit(event);
      }, transferOptions.fallbackDir, { adapter: {
        verifySize: true, stallProvider: 'TeraBox',
        readMeta: async (accountId, fileId) => {
          const reader = await this.client(accountId);
          if (!reader.fileMeta) throw new Error('Téléchargement TeraBox indisponible.');
          const meta = await reader.fileMeta(decodePath(fileId));
          return { mimeType: mimeFromName(meta.name), size: meta.size };
        },
        openMedia: async (accountId, fileId, signal, from, validator, expectedSize) => {
          const reader = await this.client(accountId);
          if (!reader.fileMeta || !reader.openContent) throw new Error('Téléchargement TeraBox indisponible.');
          const meta = await reader.fileMeta(decodePath(fileId));
          if (meta.size !== expectedSize) throw new Error('Le fichier TeraBox a changé pendant la préparation. Réessayez.');
          const resume = from > 0 && from < meta.size && validator ? { from, etag: validator } : undefined;
          const response = await reader.openContent(meta.url, meta.size, meta.name, signal, resume);
          if (!response.body) throw new Error('Téléchargement TeraBox vide.');
          const etag = response.headers.get('etag');
          if (response.status === 206 && (!resume || etag !== resume.etag)) {
            await response.body.cancel(); throw new Error('Reprise TeraBox non vérifiée.');
          }
          return { body: response.body, size: meta.size, start: response.status === 206 ? from : 0,
            resumed: response.status === 206, ...(etag ? { validator: etag } : {}) };
        },
      } });
    }
  }
  private async client(id: string): Promise<TeraBoxReader> {
    const account = (await this.vault.accounts()).find((a) => a.id === id);
    if (!account) throw new Error('Compte TeraBox inconnu : reconnectez-le.');
    const client = this.createWebReader(account.session);
    if (`terabox-${await client.identity()}` !== id) throw new Error('La session TeraBox ne correspond plus au compte attendu.');
    return client;
  }
  /** La session ne traverse pas les sorties publiques du service. */
  async connect(session: string, name: string, expectedId?: string) {
    name = name.trim();
    if (!name || name.length > 100) throw new Error('Indiquez un nom pour le compte TeraBox.');
    const client = this.createWebReader(session);
    const id = `terabox-${await client.identity()}`;
    if (expectedId && expectedId !== id) throw new Error('Ce compte TeraBox ne correspond pas au compte à reconnecter.');
    const quota = await client.quota();
    const account: TeraBoxStoredAccount = { id, name, session, ...quota };
    await this.vault.change((accounts) => [...accounts.filter((a) => a.id !== id), account]);
    return publicAccount(account);
  }
  async accounts() { return (await this.vault.accounts()).map(publicAccount); }
  async disconnect(id: string) {
    await this.vault.change((accounts) => accounts.filter((a) => a.id !== id));
    for (const [jobId, account] of this.transferAccounts) if (account === id) this.cancel(jobId);
  }
  async usage(id: string) {
    const client = await this.client(id); const quota = await client.quota();
    await this.vault.change((accounts) => accounts.map((a) => a.id === id ? { ...a, ...quota } : a));
    return quota;
  }
  async list(id: string, folder = 'root'): Promise<RemoteFile[]> {
    const client = await this.client(id);
    return sortRemoteFiles((await client.list(decodePath(folder))).map(toFile));
  }
  async search(id: string, query: string): Promise<RemoteFile[]> {
    const client = await this.client(id);
    return sortRemoteFiles((await client.search(query)).map(toFile));
  }
  async locate(id: string, fileId: string): Promise<{ id: string; name: string }[]> {
    // Verify account even though resolving the encoded path is local.
    await this.client(id);
    const segments = decodePath(fileId).split('/').filter(Boolean);
    segments.pop();
    let path = '';
    return segments.map((name) => { path += `/${name}`; return { id: pathId(path), name }; });
  }
  async recent(id: string, limit = 200): Promise<RemoteFile[]> {
    const client = await this.client(id); const pending = ['/']; const files: RemoteFile[] = [];
    let folders = 0;
    while (pending.length) {
      if (++folders > 200) throw new Error('Compte TeraBox trop volumineux pour lire les récents.');
      for (const entry of await client.list(pending.shift()!)) {
        if (entry.directory) pending.push(entry.path); else files.push(toFile(entry));
        if (pending.length + files.length > 5000) throw new Error('Compte TeraBox trop volumineux pour lire les récents.');
      }
    }
    return files.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, Math.max(1, Math.min(500, limit)));
  }
  async prepareFolders(base: string, paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length > 501 || paths.some((p) => typeof p !== 'string' || p.length > 4000)) throw new Error('Plan TeraBox invalide.');
    const root = base || await this.fallbackDir?.();
    if (!root) throw new Error('Dossier de destination indisponible.');
    for (const path of paths) await mkdir(relativeDir(root, path), { recursive: true });
  }
  async download(request: { id: string; accountId: string; fileId: string; name: string; size: number; dir?: string; subPath?: string }) {
    if (!this.transfers) throw new Error('Téléchargement TeraBox indisponible.');
    await this.client(request.accountId);
    if (this.transferAccounts.has(request.id) && this.transferAccounts.get(request.id) !== request.accountId) throw new Error('Transfert associé à un autre compte TeraBox.');
    this.transferAccounts.set(request.id, request.accountId);
    try { await this.transfers.start({ ...request, dir: request.dir ?? '' }, request.accountId); }
    catch (error) { this.transferAccounts.delete(request.id); throw error; }
  }
  pause(id: string) { this.transfers?.pause(id); }
  async resume(id: string) { const account = this.transferAccounts.get(id); return account && this.transfers ? this.transfers.resume(id, account) : false; }
  async cancel(id: string) { await this.transfers?.cancel(id); this.transferAccounts.delete(id); }
  async plan(id: string, folderId: string): Promise<FolderPlan> {
    const client = await this.client(id);
    const pending = [{ path: decodePath(folderId), relative: '', depth: 0 }];
    const result: FolderPlan = { files: [], folders: [], skipped: [], totalBytes: 0, truncated: false };
    while (pending.length) {
      const folder = pending.shift()!;
      for (const f of await client.list(folder.path)) {
        const path = folder.relative ? `${folder.relative}/${f.name}` : f.name;
        if (f.directory) {
          if (folder.depth >= 7 || result.folders.length >= 500) { result.truncated = true; continue; }
          result.folders.push(path); pending.push({ path: f.path, relative: path, depth: folder.depth + 1 });
        } else {
          if (result.files.length >= 2000) { result.truncated = true; continue; }
          result.files.push({ fileId: pathId(f.path), path, size: f.size, mimeType: mimeFromName(f.name) });
          result.totalBytes += f.size;
        }
      }
      if (result.files.length >= 2000 && pending.length) { result.truncated = true; break; }
    }
    return result;
  }
}
