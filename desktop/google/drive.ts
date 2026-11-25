/**
 * Accès en lecture seule à l'API Google Drive v3.
 *
 * Aucune fonction de ce module ne modifie, ne déplace ni ne supprime quoi que
 * ce soit : les seuls appels sortants sont `files.list`, `about.get` et
 * `files.get?alt=media`.
 */

import { bearer, type Endpoints } from './endpoints.ts';

export type DriveItem = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  mimeType: string;
  size: number;
  modified: string;
  parentId?: string;
};

export type DriveQuota = {
  name: string;
  email: string;
  picture?: string;
  usedBytes: number;
  quotaBytes: number;
};

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'files(id,name,mimeType,size,modifiedTime,parents),nextPageToken';
const MAX_PAGES = 10;

const escapeQuery = (value: string) => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function toItem(raw: Record<string, unknown>): DriveItem {
  const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : '';
  const size = Number(raw.size ?? 0);
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' ? raw.name : 'Sans titre',
    kind: mimeType === FOLDER_MIME ? 'folder' : 'file',
    mimeType,
    size: Number.isFinite(size) ? size : 0,
    modified: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : new Date().toISOString(),
    parentId: Array.isArray(raw.parents) && typeof raw.parents[0] === 'string' ? raw.parents[0] : undefined,
  };
}

async function fetchJson<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: bearer(token), signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `Drive a répondu ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      /* corps illisible */
    }
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

async function listAll(
  endpoints: Endpoints,
  token: string,
  query: string,
  orderBy: string,
  signal?: AbortSignal,
): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(`${endpoints.drive}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', FIELDS);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('orderBy', orderBy);
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    url.searchParams.set('supportsAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const payload = await fetchJson<{ files?: Record<string, unknown>[]; nextPageToken?: string }>(
      url.toString(),
      token,
      signal,
    );
    for (const raw of payload.files ?? []) items.push(toItem(raw));
    if (!payload.nextPageToken) break;
    pageToken = payload.nextPageToken;
  }

  return items;
}

/** Contenu d'un dossier. `root` désigne la racine du compte. */
export function listChildren(
  endpoints: Endpoints,
  token: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<DriveItem[]> {
  const query = `'${escapeQuery(folderId)}' in parents and trashed = false`;
  return listAll(endpoints, token, query, 'folder,name_natural', signal);
}

/** Recherche par nom sur l'ensemble du compte. */
export function searchFiles(
  endpoints: Endpoints,
  token: string,
  term: string,
  signal?: AbortSignal,
): Promise<DriveItem[]> {
  const query = `trashed = false and name contains '${escapeQuery(term)}'`;
  return listAll(endpoints, token, query, 'modifiedTime desc', signal);
}

/** Identité + quota du compte. */
export async function readQuota(
  endpoints: Endpoints,
  token: string,
  signal?: AbortSignal,
): Promise<DriveQuota> {
  const url = new URL(`${endpoints.drive}/about`);
  url.searchParams.set(
    'fields',
    'user(displayName,emailAddress,photoLink),storageQuota(limit,usage,usageInDrive)',
  );
  const payload = await fetchJson<{
    user?: { displayName?: string; emailAddress?: string; photoLink?: string };
    storageQuota?: { limit?: string; usage?: string; usageInDrive?: string };
  }>(url.toString(), token, signal);

  const used = Number(payload.storageQuota?.usageInDrive ?? payload.storageQuota?.usage ?? 0);
  const limit = Number(payload.storageQuota?.limit ?? 0);
  return {
    name: payload.user?.displayName?.trim() || payload.user?.emailAddress?.split('@')[0] || 'Google Drive',
    email: payload.user?.emailAddress ?? '',
    ...(payload.user?.photoLink ? { picture: payload.user.photoLink } : {}),
    usedBytes: Number.isFinite(used) ? used : 0,
    quotaBytes: Number.isFinite(limit) && limit > 0 ? limit : 0,
  };
}

export function isGoogleDocument(mimeType: string): boolean {
  return mimeType.startsWith('application/vnd.google-apps.') && mimeType !== FOLDER_MIME;
}

/** Métadonnées d'un fichier avant téléchargement. */
export async function readFileMeta(
  endpoints: Endpoints,
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<DriveItem> {
  const url = new URL(`${endpoints.drive}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,modifiedTime,parents');
  url.searchParams.set('supportsAllDrives', 'true');
  const raw = await fetchJson<Record<string, unknown>>(url.toString(), token, signal);
  return toItem(raw);
}

/** Ouvre le flux binaire d'un fichier (téléchargement réel). */
export async function openMedia(
  endpoints: Endpoints,
  token: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<{ body: ReadableStream<Uint8Array>; size?: number }> {
  const url = new URL(`${endpoints.drive}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');

  const response = await fetch(url.toString(), { headers: bearer(token), signal });
  if (!response.ok || !response.body) {
    const error = new Error(`Téléchargement refusé par Drive (${response.status}).`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  return {
    body: response.body,
    ...(Number.isFinite(length) && length > 0 ? { size: length } : {}),
  };
}
