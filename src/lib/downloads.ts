import { MB } from '../data/catalog';
import type { FileType, ProviderId } from '../data/catalog';

export type DownloadStatus = 'queued' | 'active' | 'paused' | 'done' | 'error';

export interface DownloadItem {
  id: string;
  name: string;
  type: FileType;
  size: number;
  received: number;
  speed: number;
  baseSpeed: number;
  status: DownloadStatus;
  provider: ProviderId;
  accountId: string;
  accountName: string;
  path: string[];
  addedAt: string;
  completedAt?: string;
  /**
   * Identifiant du fichier chez le fournisseur : renseigné pour tout transfert
   * piloté par le processus principal, qui écrit réellement sur le disque.
   */
  remoteId?: string;
  /** Compte Google propriétaire du fichier (identifiant côté coffre). */
  remoteAccount?: string;
  /** Message d'erreur lisible (disque plein, autorisation révoquée…). */
  error?: string;
  /** Emplacement réel du fichier une fois terminé. */
  savedPath?: string;
}

export function simulatedSpeed(size: number, seed: number): number {
  const jitter = 0.65 + ((seed % 100) / 100) * 0.8;
  const sizeFactor = size > 10 * 1024 * MB ? 0.8 : 1;
  return Math.round((18 + (seed % 27)) * MB * jitter * sizeFactor);
}

interface CreateArgs {
  id: string;
  name: string;
  type: FileType;
  size: number;
  provider: ProviderId;
  accountId: string;
  accountName: string;
  path: string[];
  seed: number;
  remoteId?: string;
  remoteAccount?: string;
}

export function createDownload(args: CreateArgs): DownloadItem {
  return {
    id: args.id,
    name: args.name,
    type: args.type,
    size: args.size,
    received: 0,
    speed: 0,
    baseSpeed: simulatedSpeed(args.size, args.seed),
    status: 'queued',
    provider: args.provider,
    accountId: args.accountId,
    accountName: args.accountName,
    path: args.path,
    addedAt: new Date().toISOString(),
    ...(args.remoteId ? { remoteId: args.remoteId } : {}),
    ...(args.remoteAccount ? { remoteAccount: args.remoteAccount } : {}),
  };
}

/**
 * Avance la file d'un intervalle donné.
 * - Les transferts actifs progressent à vitesse variable.
 * - Les transferts terminés sont marqués « done ».
 * - Les transferts en attente démarrent tant que la limite est respectée.
 */
export function advanceDownloads(
  items: DownloadItem[],
  concurrent: number,
  elapsedMs: number,
): DownloadItem[] {
  const dt = Math.min(elapsedMs, 2000) / 1000;
  const limit = Math.max(1, Math.min(6, concurrent));

  const advanced = items.map((item) => {
    // Les transferts réels (pilotés par Electron) ont leurs propres mesures.
    if (item.status !== 'active' || item.remoteId) return item;
    const speed = Math.round(item.baseSpeed * (0.78 + Math.random() * 0.44));
    const received = Math.min(item.size, item.received + speed * dt);
    if (received >= item.size) {
      return {
        ...item,
        received: item.size,
        speed: 0,
        status: 'done' as const,
        completedAt: new Date().toISOString(),
      };
    }
    return { ...item, received, speed };
  });

  let activeCount = advanced.filter((item) => item.status === 'active').length;

  // Respecte la limite de téléchargements simultanés (les plus récents repassent en attente).
  if (activeCount > limit) {
    const next = [...advanced];
    for (let i = next.length - 1; i >= 0 && activeCount > limit; i -= 1) {
      if (next[i].status === 'active') {
        next[i] = { ...next[i], status: 'queued', speed: 0 };
        activeCount -= 1;
      }
    }
    return next;
  }

  if (activeCount >= limit) return advanced;

  // Démarre les transferts en attente dans l'ordre d'ajout.
  const next = [...advanced];
  for (let i = 0; i < next.length && activeCount < limit; i += 1) {
    if (next[i].status === 'queued') {
      next[i] = {
        ...next[i],
        status: 'active',
        speed: Math.round(next[i].baseSpeed * 0.9),
      };
      activeCount += 1;
    }
  }
  return next;
}

export function formatEta(item: DownloadItem): string {
  if (item.status !== 'active' || !item.speed) return '—';
  const remaining = (item.size - item.received) / item.speed;
  if (!Number.isFinite(remaining) || remaining <= 0) return '—';
  if (remaining < 60) return `${Math.max(1, Math.round(remaining))} s`;
  const minutes = Math.floor(remaining / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60}`;
}

export const statusLabels: Record<DownloadStatus, string> = {
  queued: 'En attente',
  active: 'En cours',
  paused: 'En pause',
  done: 'Terminé',
  error: 'Échec',
};
