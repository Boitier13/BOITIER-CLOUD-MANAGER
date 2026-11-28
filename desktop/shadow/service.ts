/** Client Shadow Drive WebDAV : lecture et téléchargement uniquement. */
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { DownloadManager, relativeDir, type DownloadEvent } from '../google/downloads.ts';
import type { FolderPlan } from '../google/tree.ts';
import { mimeFromName, sortRemoteFiles, type RemoteFile } from '../mega/files.ts';
import { ShadowVault, type ShadowStoredAccount } from './vault.ts';

const PROPERTIES = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>`;
const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const stripped = (path: string) => path.replace(/\/+$/, '') || '/';

/** N'autoriser les jetons qu'à l'hôte officiel, jamais une redirection externe. */
export function validateRoot(input: string, testOrigin?: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Adresse WebDAV Shadow Drive invalide.'); }
  const allowed = url.protocol === 'https:' && url.hostname === 'drive.shadow.tech' && (!url.port || url.port === '443');
  if (!(allowed || (testOrigin && url.origin === testOrigin))) throw new Error('Utilisez une adresse HTTPS officielle drive.shadow.tech.');
  if (url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/remote.php/')) throw new Error('Adresse WebDAV Shadow Drive invalide.');
  url.pathname = `${stripped(url.pathname)}/`;
  return url.toString();
}

function idFor(pathname: string): string { return Buffer.from(pathname, 'utf8').toString('base64url'); }
function fileUrl(account: ShadowStoredAccount, id: string): URL {
  const root = new URL(account.url);
  if (!id || id === 'root') return root;
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || id.length > 8192) throw new Error('Chemin Shadow Drive invalide.');
  const pathname = Buffer.from(id, 'base64url').toString('utf8');
  const url = new URL(pathname, root);
  if (url.origin !== root.origin || (stripped(url.pathname) !== stripped(root.pathname) && !url.pathname.startsWith(root.pathname)) || url.search || url.hash) throw new Error('Chemin Shadow Drive hors du dossier autorisé.');
  return url;
}

function failure(status: number): Error {
  if (status === 401 || status === 403) return new Error('Shadow Drive refuse l’accès : vérifiez le nom et le jeton WebDAV, puis reconnectez le compte.');
  if (status === 404) return new Error('Élément Shadow Drive introuvable.');
  if (status === 429) return new Error('Shadow Drive demande de patienter avant de réessayer.');
  return new Error(`Shadow Drive a refusé la demande (${status}).`);
}

interface DavResult { file: RemoteFile; used: number; available: number; }

export class ShadowService {
  private readonly vault: ShadowVault;
  private readonly testOrigin?: string;
  private readonly transfers: DownloadManager;
  private readonly fallbackDir: () => Promise<string>;
  private readonly transferAccounts = new Map<string, string>();
  constructor(vault: ShadowVault, emit: (event: DownloadEvent) => void, fallbackDir: () => Promise<string>, testOrigin?: string) {
    this.vault = vault; this.testOrigin = testOrigin; this.fallbackDir = fallbackDir;
    this.transfers = new DownloadManager({ drive: '' } as never, (event) => {
      if (event.status === 'done') this.transferAccounts.delete(event.id);
      emit(event);
    }, fallbackDir, {
      adapter: {
        readMeta: async (accountId, fileId, signal) => {
          const account = await this.account(accountId);
          const rows = await this.propfind(account, fileUrl(account, fileId), 0, signal);
          if (!rows.length || rows[0].file.kind !== 'file') throw new Error('Fichier Shadow Drive introuvable.');
          return { mimeType: rows[0].file.mimeType, size: rows[0].file.size };
        },
        openMedia: async (accountId, fileId, signal) => {
          const account = await this.account(accountId);
          const response = await this.request(account, fileUrl(account, fileId), { method: 'GET', signal });
          if (!response.ok || !response.body) throw failure(response.status);
          const length = Number(response.headers.get('content-length') ?? 0);
          // Sans validation d'identité (ETag), ne jamais concaténer un fichier modifié.
          return { body: response.body, ...(length > 0 ? { size: length } : {}), start: 0, resumed: false };
        },
      },
    });
  }
  private async account(id: string): Promise<ShadowStoredAccount> {
    const account = (await this.vault.accounts()).find((item) => item.id === id);
    if (!account) throw new Error('Compte Shadow Drive inconnu : reconnectez-le.');
    validateRoot(account.url, this.testOrigin);
    return account;
  }
  private async request(account: ShadowStoredAccount, url: URL, init: RequestInit): Promise<Response> {
    const root = new URL(validateRoot(account.url, this.testOrigin));
    if (url.origin !== root.origin || (stripped(url.pathname) !== stripped(root.pathname) && !url.pathname.startsWith(root.pathname))) throw new Error('Adresse Shadow Drive non autorisée.');
    const auth = Buffer.from(`${account.username}:${account.token}`, 'utf8').toString('base64');
    try {
      return await fetch(url, {
        ...init, redirect: 'error',
        headers: { ...init.headers, authorization: `Basic ${auth}` },
        signal: init.method === 'GET' && init.signal ? init.signal : init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      if (init.signal?.aborted) throw cause;
      throw new Error('Connexion à Shadow Drive impossible ou redirection refusée. Vérifiez le réseau et l’adresse WebDAV.');
    }
  }
  private async propfind(account: ShadowStoredAccount, target: URL, depth: 0 | 1, signal?: AbortSignal): Promise<DavResult[]> {
    const response = await this.request(account, target, { method: 'PROPFIND', headers: { depth: String(depth), 'content-type': 'application/xml; charset=utf-8' }, body: PROPERTIES, signal });
    if (response.status !== 207) throw failure(response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Réponse Shadow Drive vide.');
    let size = 0; const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Dossier Shadow Drive trop volumineux pour être lu.'); }
      chunks.push(part.value);
    }
    const content = Buffer.concat(chunks).toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(content) || XMLValidator.validate(content) !== true) throw new Error('Réponse Shadow Drive invalide.');
    const data = xml.parse(content) as { multistatus?: { response?: unknown } };
    if (!data.multistatus) throw new Error('Réponse Shadow Drive invalide.');
    const root = new URL(account.url);
    const results: DavResult[] = [];
    for (const raw of array(data.multistatus.response)) {
      const row = raw as { href?: string; propstat?: unknown };
      if (typeof row.href !== 'string') continue;
      let href: URL;
      try { href = new URL(row.href, target); } catch { continue; }
      if (href.origin !== root.origin || (stripped(href.pathname) !== stripped(root.pathname) && !href.pathname.startsWith(root.pathname))) continue;
      const relative = stripped(href.pathname).slice(stripped(target.pathname).length);
      if (relative && (!relative.startsWith('/') || relative.slice(1).includes('/'))) continue;
      if (depth === 0 && relative) continue;
      const good = array(row.propstat).map((v) => v as { status?: string; prop?: Record<string, unknown> }).find((v) => /\s200\s/.test(v.status ?? ''));
      const prop = good?.prop;
      if (!prop) continue;
      const resource = prop.resourcetype as Record<string, unknown> | undefined;
      const folder = !!resource && typeof resource === 'object' && 'collection' in resource;
      let name: string;
      try { name = decodeURIComponent(stripped(href.pathname).split('/').pop() ?? ''); } catch { continue; }
      if (!name || name.includes('/') || name === '.' || name === '..') continue;
      const bytes = Math.max(0, Number(prop.getcontentlength) || 0);
      const date = new Date(String(prop.getlastmodified ?? ''));
      results.push({ file: { id: idFor(href.pathname), name, kind: folder ? 'folder' : 'file', mimeType: folder ? 'shadow/folder' : mimeFromName(name), size: folder ? 0 : bytes, modified: Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString() }, used: Math.max(0, Number(prop['quota-used-bytes']) || 0), available: Math.max(0, Number(prop['quota-available-bytes']) || 0) });
    }
    return results;
  }
  async connect(username: string, token: string, address: string, expectedId?: string): Promise<{ accountId: string; name: string; username: string; usedBytes: number; quotaBytes: number; url: string; status: 'connected' }> {
    username = username.trim();
    if (!username || username.includes(':') || !token) throw new Error('Renseignez l’identifiant et le jeton WebDAV Shadow Drive.');
    const url = validateRoot(address, this.testOrigin);
    const id = `shadow-${createHash('sha256').update(`${url}\0${username}`).digest('hex').slice(0, 24)}`;
    if (expectedId && expectedId !== id) throw new Error('Cet identifiant ou cette adresse WebDAV ne correspond pas au compte à reconnecter.');
    const account = { id, name: username, username, token, url, usedBytes: 0, quotaBytes: 0 };
    const rows = await this.propfind(account, new URL(url), 0);
    if (!rows.length || rows[0].file.kind !== 'folder') throw new Error('L’adresse WebDAV ne désigne pas un dossier Shadow Drive accessible.');
    account.usedBytes = rows[0].used;
    account.quotaBytes = rows[0].used + rows[0].available;
    await this.vault.change((accounts) => [...accounts.filter((a) => a.id !== id), account]);
    return this.publicAccount(account);
  }
  private publicAccount(account: ShadowStoredAccount) {
    return { accountId: account.id, name: account.name, username: account.username, url: account.url, usedBytes: account.usedBytes, quotaBytes: account.quotaBytes, status: 'connected' as const };
  }
  async accounts() { return (await this.vault.accounts()).map((a) => this.publicAccount(a)); }
  async disconnect(id: string) { await this.vault.change((accounts) => accounts.filter((a) => a.id !== id)); }
  async usage(id: string) {
    const account = await this.account(id); const data = await this.propfind(account, new URL(account.url), 0);
    if (!data.length) throw new Error('Quota Shadow Drive indisponible.');
    const usedBytes = data[0].used, quotaBytes = usedBytes + data[0].available;
    await this.vault.change((accounts) => accounts.map((a) => a.id === id ? { ...a, usedBytes, quotaBytes } : a));
    return { usedBytes, quotaBytes };
  }
  async list(id: string, folderId: string): Promise<RemoteFile[]> {
    const account = await this.account(id), target = fileUrl(account, folderId);
    const rows = await this.propfind(account, target, 1);
    return sortRemoteFiles(rows.filter((row) => stripped(fileUrl(account, row.file.id).pathname) !== stripped(target.pathname)).map((row) => row.file));
  }
  async plan(id: string, folderId: string): Promise<FolderPlan> {
    const plan: FolderPlan = { files: [], folders: [], skipped: [], truncated: false, totalBytes: 0 };
    const pending = [{ id: folderId, path: '', depth: 0 }];
    while (pending.length) {
      const folder = pending.shift()!;
      for (const file of await this.list(id, folder.id)) {
        const path = folder.path ? `${folder.path}/${file.name}` : file.name;
        if (file.kind === 'folder') {
          if (plan.folders.length >= 500 || folder.depth >= 7) { plan.truncated = true; continue; }
          plan.folders.push(path); pending.push({ id: file.id, path, depth: folder.depth + 1 });
        } else {
          if (plan.files.length >= 2000) { plan.truncated = true; continue; }
          plan.files.push({ fileId: file.id, path, size: file.size, mimeType: file.mimeType }); plan.totalBytes += file.size;
        }
      }
      if (plan.files.length >= 2000) { if (pending.length) plan.truncated = true; break; }
    }
    return plan;
  }
  /** Parcours borné et séquentiel : pas de rafale de requêtes ni de résultat tronqué caché. */
  private async allFiles(id: string): Promise<RemoteFile[]> {
    const pending = ['root']; const files: RemoteFile[] = [];
    let folders = 0;
    while (pending.length) {
      if (++folders > 200) throw new Error('Recherche Shadow Drive trop volumineuse : ouvrez un sous-dossier pour le parcourir.');
      for (const item of await this.list(id, pending.shift()!)) {
        if (item.kind === 'folder') pending.push(item.id);
        files.push(item);
        if (files.length + pending.length > 5000) throw new Error('Recherche Shadow Drive trop volumineuse : ouvrez un sous-dossier pour le parcourir.');
      }
    }
    return files;
  }
  async search(id: string, term: string): Promise<RemoteFile[]> {
    const query = term.trim().toLocaleLowerCase();
    if (query.length < 2) return [];
    return (await this.allFiles(id)).filter((f) => f.name.toLocaleLowerCase().includes(query)).slice(0, 200);
  }
  async recent(id: string, limit = 200): Promise<RemoteFile[]> {
    return (await this.allFiles(id)).filter((f) => f.kind === 'file').sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, Math.max(1, Math.min(500, limit)));
  }
  async locate(id: string, fileId: string): Promise<{ id: string; name: string }[]> {
    const account = await this.account(id);
    const root = new URL(account.url); const target = fileUrl(account, fileId);
    const relative = target.pathname.slice(root.pathname.length).split('/').filter(Boolean);
    relative.pop();
    let path = root.pathname;
    return relative.map((segment) => {
      path += `${segment}/`;
      return { id: idFor(path), name: decodeURIComponent(segment) };
    });
  }
  async prepareFolders(base: string, paths: string[]): Promise<void> {
    if (!Array.isArray(paths) || paths.length > 501 || paths.some((path) => typeof path !== 'string' || path.length > 4000)) throw new Error('Plan de dossiers Shadow Drive invalide.');
    const root = base || await this.fallbackDir();
    for (const path of paths) await mkdir(relativeDir(root, path), { recursive: true });
  }
  async download(request: { id: string; accountId: string; fileId: string; name: string; size: number; dir?: string; subPath?: string }) {
    await this.account(request.accountId);
    this.transferAccounts.set(request.id, request.accountId);
    await this.transfers.start({ ...request, dir: request.dir ?? '' }, request.accountId);
  }
  pause(id: string) { this.transfers.pause(id); }
  async resume(id: string) { const account = this.transferAccounts.get(id); return account ? this.transfers.resume(id, account) : false; }
  async cancel(id: string) { await this.transfers.cancel(id); this.transferAccounts.delete(id); }
}
