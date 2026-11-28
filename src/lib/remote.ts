/**
 * Catalogue réel, chargé à la demande depuis Google Drive.
 *
 * Seuls les comptes connectés passent par ce cache. Une requête en cours par
 * dossier ; les réponses sont conservées pour éviter de solliciter l'API à
 * chaque rendu.
 *
 * **Toutes les clés de ce module sont des identifiants Google**, jamais les
 * identifiants internes de l'application (`gdrive-real-…`) : ce sont les seuls
 * que le processus principal sait retrouver dans son coffre. Les confondre
 * produisait « Compte Google inconnu » au premier affichage de dossier.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { FileNode } from '../data/catalog';
import { getBridge, type GoogleFile } from './bridge';
import {
  listFolder,
  providerOf,
  recentAccount,
  searchAccount,
  sharedAccount,
} from './cloud';
import { GOOGLE_ROOT, toNode } from './google';
import { messageLisible } from './errors';
import { marquerPhase } from './trace';
import { SerialQueue } from './serialQueue';
import { appendUniqueNodes } from './uniqueNodes';

export interface FolderState {
  nodes: FileNode[];
  status: 'loading' | 'ready' | 'error';
  error?: string;
}

/** Séparation `nom lisible::identifiant Drive` dans les segments de chemin. */
export const ID_SEPARATOR = '::';

/**
 * Clé de l'ensemble « partagés avec moi ».
 *
 * Ce n'est pas un dossier : les fichiers partagés n'existent dans aucun dossier
 * de l'utilisateur. On réutilise le cache de dossiers en donnant à cet ensemble
 * une clé qui ne peut pas entrer en collision avec un chemin réel.
 */
export const SHARED_KEY = '::shared';

export const sharedKey = (accountId: string): string => `${accountId}${SHARED_KEY}`;

export const folderKey = (accountId: string, path: string[]): string =>
  `${accountId}::${path.join('/')}`;

/**
 * Clé du flux « modifiés récemment ».
 *
 * Ce n'est pas un dossier non plus : la liste traverse tous les dossiers du
 * compte. On garde une clé distincte pour ne pas la confondre avec la racine.
 */
export const recentKey = (accountId: string): string => `${accountId}::recent`;

/** Extrait l'identifiant Drive du dernier segment de chemin. */
export function driveFolderId(path: string[]): string {
  if (!path.length) return GOOGLE_ROOT;
  const last = path[path.length - 1];
  const index = last.lastIndexOf(ID_SEPARATOR);
  return index > 0 ? last.slice(index + ID_SEPARATOR.length) : GOOGLE_ROOT;
}

/** Respiration entre deux lectures de « récents » MEGA (session + arborescence). */
const RECENTS_MEGA_ESPACEMENT_MS = 1_500;

class RemoteCatalog {
  private states = new Map<string, FolderState>();
  /** Comptes MEGA en attente de lecture des « récents ». */
  private readonly fileRecents = new SerialQueue<string>(
    (compte) => this.fetchRecent(compte, recentKey(compte)),
    () => new Promise((resolve) => window.setTimeout(resolve, RECENTS_MEGA_ESPACEMENT_MS)),
  );
  private listeners = new Set<() => void>();
  private snapshot = new Map<string, FolderState>();
  private counter = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = (key: string): FolderState | undefined => this.snapshot.get(key);

  entries = (): FolderState[] => [...this.snapshot.values()];

  private publish(): void {
    this.snapshot = new Map(this.states);
    this.counter += 1;
    for (const listener of this.listeners) listener();
  }

  /** Change à chaque mise à jour : sert de signal aux vues dérivées. */
  get revision(): number {
    return this.counter;
  }

  searchKey(accountId: string, term: string): string {
    return `search::${accountId}::${term.trim().toLowerCase()}`;
  }

  invalidate(accountId?: string): void {
    if (!accountId) {
      this.states.clear();
    } else {
      for (const key of [...this.states.keys()]) {
        if (key.startsWith(`${accountId}::`) || key.startsWith(`search::${accountId}::`)) {
          this.states.delete(key);
        }
      }
    }
    this.publish();
  }

  /** Charge le contenu d'un dossier (sans effet si déjà chargé). */
  load(accountId: string, path: string[]): void {
    const key = folderKey(accountId, path);
    const existing = this.states.get(key);
    if (existing && existing.status === 'ready') return;
    if (existing && existing.status === 'loading') return;
    void this.fetchFolder(accountId, path, key);
  }

  /** Force le rechargement d'un dossier. */
  reload(accountId: string, path: string[]): void {
    this.states.delete(folderKey(accountId, path));
    this.load(accountId, path);
  }

  private async fetchFolder(accountId: string, path: string[], key: string): Promise<void> {
    const client = getBridge();
    if (!client) return;
    this.states.set(key, { nodes: [], status: 'loading' });
    this.publish();
    marquerPhase(`lecture d’un dossier (${accountId})`);
    try {
      const files = await listFolder(accountId, driveFolderId(path));
      this.states.set(key, { nodes: files.map(toNode), status: 'ready' });
    } catch (cause) {
      this.states.set(key, {
        nodes: [],
        status: 'error',
        error: messageLisible(cause) || 'Google Drive est injoignable.',
      });
    }
    this.publish();
  }

  /** Charge la liste des fichiers partagés avec ce compte. */
  loadShared(accountId: string): void {
    const key = sharedKey(accountId);
    const existing = this.states.get(key);
    if (existing && existing.status !== 'error') return;
    void this.fetchShared(accountId, key);
  }

  private async fetchShared(accountId: string, key: string): Promise<void> {
    const client = getBridge();
    if (!client) return;
    this.states.set(key, { nodes: [], status: 'loading' });
    this.publish();
    try {
      const files = await sharedAccount(accountId);
      this.states.set(key, { nodes: files.map(toNode), status: 'ready' });
    } catch (cause) {
      this.states.set(key, {
        nodes: [],
        status: 'error',
        error: messageLisible(cause) || 'Les fichiers partagés sont injoignables.',
      });
    }
    this.publish();
  }

  /** Force la relecture du flux « récents » (bouton Actualiser). */
  reloadRecent(accountId: string): void {
    const key = recentKey(accountId);
    this.states.delete(key);
    this.loadRecent(accountId);
  }

  /**
   * Charge les derniers fichiers modifiés du compte (une fois).
   *
   * Les comptes Google répondent à une requête ; les comptes MEGA, eux,
   * exigent d'ouvrir une session et de lire **toute** l'arborescence. Onze
   * comptes MEGA demandés d'un coup, c'était onze connexions en rafale : MEGA
   * bloquait les derniers (`-16`), et la machine passait plusieurs minutes à
   * charger des arborescences. Les comptes MEGA passent donc par une file, un
   * par un, avec une respiration.
   */
  loadRecent(accountId: string): void {
    const key = recentKey(accountId);
    const existing = this.states.get(key);
    if (existing && existing.status !== 'error') return;
    if (providerOf(accountId) === 'mega' || providerOf(accountId) === 'shadow' || providerOf(accountId) === 'terabox') {
      this.states.set(key, { nodes: [], status: 'loading' });
      this.publish();
      this.fileRecents.ajouter(accountId);
      return;
    }
    void this.fetchRecent(accountId, key);
  }

  private async fetchRecent(accountId: string, key: string): Promise<void> {
    const client = getBridge();
    if (!client) return;
    this.states.set(key, { nodes: [], status: 'loading' });
    this.publish();
    marquerPhase(`lecture des récents (${accountId})`);
    try {
      const files = await recentAccount(accountId, { days: 90, limit: 200 });
      this.states.set(key, { nodes: files.map(toNode), status: 'ready' });
    } catch (cause) {
      this.states.set(key, {
        nodes: [],
        status: 'error',
        error: messageLisible(cause) || 'Les fichiers récents sont injoignables.',
      });
    }
    marquerPhase('au repos');
    this.publish();
  }

  search(accountId: string, term: string): void {
    const query = term.trim();
    if (query.length < 2) return;
    const key = this.searchKey(accountId, query);
    const existing = this.states.get(key);
    if (existing && existing.status !== 'error') return;
    void this.fetchSearch(accountId, query, key);
  }

  private async fetchSearch(accountId: string, query: string, key: string): Promise<void> {
    const client = getBridge();
    if (!client) return;
    this.states.set(key, { nodes: [], status: 'loading' });
    this.publish();
    try {
      const files = await searchAccount(accountId, query.trim());
      this.states.set(key, { nodes: files.map(toNode), status: 'ready' });
    } catch (cause) {
      this.states.set(key, {
        nodes: [],
        status: 'error',
        error: messageLisible(cause) || 'Recherche impossible.',
      });
    }
    this.publish();
  }

  /** Chemins des dossiers déjà chargés d'un compte. */
  loadedPaths(accountId: string): string[][] {
    const paths: string[][] = [];
    for (const key of this.snapshot.keys()) {
      if (!key.startsWith(`${accountId}::`)) continue;
      const rest = key.slice(accountId.length + 2);
      paths.push(rest ? rest.split('/') : []);
    }
    return paths.sort((a, b) => a.length - b.length);
  }

  /** Tous les nœuds déjà chargés (dossiers visités), pour les compteurs. */
  nodesOf(accountId: string): FileNode[] {
    const nodes: FileNode[] = [];
    for (const [key, state] of this.snapshot) {
      if (key.startsWith(`${accountId}::`) && state.status === 'ready') {
        nodes.push(...state.nodes);
      }
    }
    return nodes;
  }
}

export const remoteCatalog = new RemoteCatalog();

/**
 * Arborescence partielle d'un compte réel : uniquement les dossiers déjà
 * visités, imbriqués selon leur chemin. Sert aux vues globales (favoris,
 * suggestions) sans télécharger tout le Drive.
 */
export function remoteTree(
  accountId: string,
  options: { includeShared?: boolean } = {},
): FileNode[] {
  const root: FileNode[] = [];
  const folders = new Map<string, FileNode[]>();
  const idsParDossier = new Map<FileNode[], Set<string>>();
  folders.set('', root);
  idsParDossier.set(root, new Set());

  const ensure = (path: string[]): FileNode[] => {
    const key = path.join('/');
    const existing = folders.get(key);
    if (existing) return existing;
    const parent = ensure(path.slice(0, -1));
    const last = path[path.length - 1];
    const node: FileNode = {
      id: `remote-${accountId}-${key}`,
      name: displaySegment(last),
      type: 'folder',
      size: 0,
      modified: new Date(0).toISOString(),
      children: [],
    };
    parent.push(node);
    idsParDossier.get(parent)?.add(node.id);
    const list = node.children as FileNode[];
    idsParDossier.set(list, new Set());
    folders.set(key, list);
    return list;
  };

  const shared = options.includeShared ? remoteCatalog.get(sharedKey(accountId)) : undefined;
  if (shared && shared.status === 'ready') {
    appendUniqueNodes(root, shared.nodes, idsParDossier.get(root)!);
  }

  for (const path of remoteCatalog.loadedPaths(accountId)) {
    const parent = ensure(path);
    const state = remoteCatalog.get(folderKey(accountId, path));
    if (!state || state.status !== 'ready') continue;
    appendUniqueNodes(parent, state.nodes, idsParDossier.get(parent)!);
  }
  return root;
}

/**
 * Derniers fichiers modifiés, agrégés sur plusieurs comptes.
 *
 * Le flux n'est pas stocké tel quel : on combine les réponses déjà en cache,
 * triées par date de modification. Chaque entrée garde son compte d'origine,
 * sinon un fichier « récent » deviendrait impossible à ouvrir.
 */
export function useRemoteRecent(accountIds: string[], enabled: boolean): {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  files: { accountId: string; file: FileNode; modified: string }[];
} {
  // La clé de dépendance doit être stable : un tableau recréé à chaque rendu
  // relancerait la souscription en boucle.
  const signature = accountIds.join(',');
  const snapshot = useSyncExternalStore(remoteCatalog.subscribe, () => {
    if (!enabled) return '';
    return accountIds
      .map((id) => {
        const state = remoteCatalog.get(recentKey(id));
        return `${id}:${state?.status ?? 'idle'}:${state?.nodes.length ?? 0}`;
      })
      .join('|');
  });

  useEffect(() => {
    if (!enabled) return;
    for (const id of accountIds) remoteCatalog.loadRecent(id);
    // `signature` suffit : c'est le contenu du tableau qui compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, signature]);

  return useMemo(() => {
    if (!enabled) return { status: 'idle' as const, files: [] };
    const files: { accountId: string; file: FileNode; modified: string }[] = [];
    let loading = false;
    let failed: string | undefined;
    for (const id of accountIds) {
      const state = remoteCatalog.get(recentKey(id));
      if (!state || state.status === 'loading') loading = true;
      if (state?.status === 'error' && !failed) failed = state.error;
      for (const file of state?.nodes ?? []) {
        files.push({ accountId: id, file, modified: file.modified });
      }
    }
    files.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    if (failed) return { status: 'error' as const, error: failed, files };
    if (loading) return { status: 'loading' as const, files };
    return { status: 'ready' as const, files };
  }, [enabled, signature, snapshot]);
}

/** État d'un dossier distant, chargé automatiquement (sans rechargement). */
export function useRemoteShared(
  accountId: string | null,
  enabled: boolean,
): FolderState | undefined {
  const key = accountId ? sharedKey(accountId) : '';
  const state = useSyncExternalStore(remoteCatalog.subscribe, () =>
    accountId && enabled ? remoteCatalog.get(key) : undefined,
  );

  useEffect(() => {
    if (!enabled || !accountId) return;
    remoteCatalog.loadShared(accountId);
  }, [accountId, enabled]);

  return state;
}

export function useRemoteFolder(
  accountId: string | null,
  path: string[],
  enabled: boolean,
): FolderState | undefined {
  const key = accountId ? folderKey(accountId, path) : '';
  const join = path.join('/');
  const state = useSyncExternalStore(remoteCatalog.subscribe, () =>
    accountId && enabled ? remoteCatalog.get(key) : undefined,
  );

  useEffect(() => {
    if (!enabled || !accountId) return;
    remoteCatalog.load(accountId, join ? join.split('/') : []);
  }, [accountId, enabled, join]);

  return state;
}

/**
 * Recherche dans **plusieurs** comptes à la fois.
 *
 * Chaque compte a sa propre requête : Drive ne sait pas chercher dans plusieurs
 * espaces (comptes Google distincts) d'un seul appel. On interroge donc tous les
 * comptes demandés et l'on renvoie l'état de chacun — y compris les échecs, qui
 * doivent être visibles (une autorisation expirée sur un compte ne doit pas
 * faire croire à l'absence de résultat).
 *
 * Aucun appel n'est refait : le cache du catalogue sait qu'une recherche déjà
 * obtenue n'a pas besoin d'être relancée.
 */
export function useSearchAcross(
  accountIds: string[],
  term: string,
  enabled: boolean,
): Map<string, FolderState> {
  const query = term.trim();
  const active = enabled && query.length >= 2;
  // Abonnement : toute réponse du catalogue provoque un nouveau rendu.
  useSyncExternalStore(remoteCatalog.subscribe, () => remoteCatalog.revision);

  const idsKey = accountIds.join('|');
  useEffect(() => {
    if (!active) return;
    for (const id of accountIds) remoteCatalog.search(id, query);
    // `idsKey` remplace le tableau : deux tableaux égaux ne sont jamais égaux.
  }, [active, query, idsKey]);

  const states = new Map<string, FolderState>();
  if (!active) return states;
  for (const id of accountIds) {
    const state = remoteCatalog.get(remoteCatalog.searchKey(id, query));
    if (state) states.set(id, state);
  }
  return states;
}

/** Résultat d'une recherche distante (dès 2 caractères). */
export function useRemoteSearch(
  accountId: string | null,
  term: string,
  enabled: boolean,
): FolderState | undefined {
  const query = term.trim();
  const key = accountId ? remoteCatalog.searchKey(accountId, query) : '';
  const state = useSyncExternalStore(remoteCatalog.subscribe, () =>
    accountId && enabled && query.length >= 2 ? remoteCatalog.get(key) : undefined,
  );

  useEffect(() => {
    if (!enabled || !accountId || query.length < 2) return;
    remoteCatalog.search(accountId, query);
  }, [accountId, enabled, query]);

  return state;
}

/** Recharge un compte ou un dossier (bouton resynchroniser). */
export function useReloadRemote(): (accountId: string | null, path?: string[]) => void {
  return useCallback((accountId: string | null, path?: string[]) => {
    if (!accountId) return;
    if (path) remoteCatalog.reload(accountId, path);
    else {
      remoteCatalog.invalidate(accountId);
      remoteCatalog.load(accountId, []);
    }
  }, []);
}

/** Ajoute l'identifiant Drive au nom, pour reconstruire le chemin inverse. */
export function segmentFor(file: GoogleFile): string {
  return `${file.name}${ID_SEPARATOR}${file.id}`;
}

/** Retire l'identifiant Drive d'un segment de chemin (affichage). */
export function displaySegment(segment: string): string {
  const index = segment.lastIndexOf(ID_SEPARATOR);
  return index > 0 ? segment.slice(0, index) : segment;
}

/** Chargement en cours quelque part pour ce compte. */
export function useRemoteBusy(accountId: string | null): boolean {
  const states = useSyncExternalStore(remoteCatalog.subscribe, () => remoteCatalog.entries());
  return useMemo(
    () => Boolean(accountId) && states.some((state) => state.status === 'loading'),
    [states, accountId],
  );
}
