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
  /**
   * Espace **total** du compte : Drive + Gmail + Photos.
   *
   * C'est le seul chiffre honnête quand l'interface écrit « utilisé sur
   * 15 Go » : ne compter que Drive ferait croire à un compte presque vide
   * alors que Gmail en occupe le tiers.
   */
  usedBytes: number;
  quotaBytes: number;
  /**
   * `usage` couvre Drive + Gmail + Photos ; `usageInDrive` ne couvre que Drive.
   * Les deux sont conservés : c'est leur écart qui dit si l'on peut afficher
   * une répartition honnête, ou s'il faut se taire.
   */
  usageBytes?: number;
  usageInDriveBytes?: number;
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
  /** Arrête la pagination dès ce nombre d'éléments (flux « derniers fichiers »). */
  limit?: number,
): Promise<DriveItem[]> {
  const items: DriveItem[] = [];
  let pageToken: string | undefined;
  const ceiling = limit && limit > 0 ? limit : Infinity;

  for (let page = 0; page < MAX_PAGES && items.length < ceiling; page += 1) {
    const url = new URL(`${endpoints.drive}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', FIELDS);
    // On ne demande jamais plus que ce qui manque : inutile de rapatrier
    // 1000 entrées pour en garder 60.
    url.searchParams.set('pageSize', String(Math.min(1000, ceiling - items.length)));
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

/**
 * Métadonnées d'un élément précis (dossier ou fichier).
 *
 * Sert à retrouver **où** se trouve un fichier trouvé par la recherche : Drive
 * ne renvoie que l'identifiant du dossier parent, jamais son nom ni son chemin.
 * L'identifiant `root` désigne la racine du compte.
 */
export async function readItem(
  endpoints: Endpoints,
  token: string,
  id: string,
  signal?: AbortSignal,
): Promise<DriveItem> {
  const url = new URL(`${endpoints.drive}/files/${encodeURIComponent(id)}`);
  url.searchParams.set('fields', 'id,name,mimeType,size,modifiedTime,parents');
  url.searchParams.set('supportsAllDrives', 'true');
  const raw = await fetchJson<Record<string, unknown>>(url.toString(), token, signal);
  return toItem(raw);
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

/**
 * Fichiers partagés avec ce compte par d'autres personnes, et fichiers dont il
 * est propriétaire mais qui sont partagés.
 *
 * Requête distincte de `listChildren` : un fichier partagé n'est pas dans un
 * dossier de l'utilisateur, il n'apparaîtrait donc jamais en parcourant la
 * racine. C'est un manque réel, pas un filtre manquant.
 */
export function listShared(
  endpoints: Endpoints,
  token: string,
  signal?: AbortSignal,
): Promise<DriveItem[]> {
  const query = 'sharedWithMe = true and trashed = false';
  return listAll(endpoints, token, query, 'modifiedTime desc', signal);
}

/**
 * Somme des tailles d'une requête Drive, sans rapatrier les métadonnées.
 *
 * Sert à la répartition du stockage par catégorie. Volontairement borné : la
 * fonction renvoie `partial: true` si le plafond de pages est atteint, pour que
 * l'écran puisse annoncer un chiffre incomplet au lieu de faire croire à un
 * total exact.
 */
export async function sumBytes(
  endpoints: Endpoints,
  token: string,
  query: string,
  options: { maxPages?: number; signal?: AbortSignal } = {},
): Promise<{ bytes: number; count: number; partial: boolean }> {
  const pages = Math.max(1, Math.min(20, options.maxPages ?? 10));
  let bytes = 0;
  let count = 0;
  let pageToken: string | undefined;

  for (let page = 0; page < pages; page += 1) {
    const url = new URL(`${endpoints.drive}/files`);
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(size),nextPageToken');
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    url.searchParams.set('supportsAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const payload = await fetchJson<{
      files?: { size?: string }[];
      nextPageToken?: string;
    }>(url.toString(), token, options.signal);
    for (const raw of payload.files ?? []) {
      bytes += Number(raw.size ?? 0) || 0;
      count += 1;
    }
    if (!payload.nextPageToken) return { bytes, count, partial: false };
    pageToken = payload.nextPageToken;
  }

  return { bytes, count, partial: true };
}

/**
 * Derniers fichiers modifiés sur l'ensemble du compte.
 *
 * Ce que Google sait : la **date de modification**. Ce qu'il ne transmet pas :
 * la date d'ouverture. Un fichier ouvert tous les jours mais jamais modifié
 * n'apparaîtra donc jamais ici — c'est une limite de l'API, pas un oubli, et
 * l'écran le dit à l'utilisateur plutôt que de laisser croire à un historique.
 *
 * `days` borne la fenêtre côté Google (la requête ne remonte que du récent),
 * `limit` borne le volume : inutile de rapatrier un compte entier.
 */
export function listRecent(
  endpoints: Endpoints,
  token: string,
  options: { days?: number; limit?: number; signal?: AbortSignal } = {},
): Promise<DriveItem[]> {
  const days = Math.max(1, Math.min(365, options.days ?? 90));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const query = `trashed = false and modifiedTime > '${since}'`;
  return listAll(
    endpoints,
    token,
    query,
    'modifiedTime desc',
    options.signal,
    Math.max(1, Math.min(1000, options.limit ?? 200)),
  );
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

  // L'espace consommé est le total du compte. `usageInDrive` sert à la seule
  // répartition Drive / Gmail / Photos : le prendre pour le total sous-estime
  // l'occupation (un compte à 5 Go de Gmail s'affichait « 6 Mo / 0 % »).
  const used = Number(payload.storageQuota?.usage ?? payload.storageQuota?.usageInDrive ?? 0);
  const limit = Number(payload.storageQuota?.limit ?? 0);
  const usage = Number(payload.storageQuota?.usage ?? 0);
  const usageInDrive = Number(payload.storageQuota?.usageInDrive ?? 0);
  return {
    name: payload.user?.displayName?.trim() || payload.user?.emailAddress?.split('@')[0] || 'Google Drive',
    email: payload.user?.emailAddress ?? '',
    ...(payload.user?.photoLink ? { picture: payload.user.photoLink } : {}),
    usedBytes: Number.isFinite(used) ? used : 0,
    quotaBytes: Number.isFinite(limit) && limit > 0 ? limit : 0,
    ...(Number.isFinite(usage) && usage > 0 ? { usageBytes: usage } : {}),
    ...(Number.isFinite(usageInDrive) && usageInDrive > 0 ? { usageInDriveBytes: usageInDrive } : {}),
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
