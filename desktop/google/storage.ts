/**
 * Répartition du stockage d'un compte Google.
 *
 * Deux natures d'information, volontairement séparées :
 *
 *   1. **Ce que Google dit** — `storageQuota.usage` (Drive + Gmail + Photos) et
 *      `storageQuota.usageInDrive` (Drive seul). C'est exact et gratuit.
 *   2. **Ce qu'on mesure** — la taille des fichiers par catégorie, obtenue en
 *      additionnant les tailles renvoyées par `files.list`. Coûteux, donc borné,
 *      et parfois partiel : chaque catégorie dit si son chiffre est complet.
 *
 * Aucune estimation n'est inventée : une catégorie non mesurée est absente, et
 * un chiffre partiel est signalé comme tel.
 */

import { sumBytes, type DriveQuota } from './drive.ts';
import type { Endpoints } from './endpoints.ts';

export type StorageCategoryId =
  | 'document'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'other';

export type StorageCategory = {
  id: StorageCategoryId;
  bytes: number;
  count: number;
  /** Le plafond de pages a été atteint : la somme est incomplète. */
  partial: boolean;
};

export type StorageUsage = {
  usedBytes: number;
  quotaBytes: number;
  /**
   * Répartition Drive / Gmail / Photos, seulement quand Google la distingue.
   * `null` = information indisponible : on préfère ne rien afficher.
   */
  emailBytes: number | null;
  categories: StorageCategory[];
  /** Vrai si au moins une catégorie est incomplète. */
  partial: boolean;
};

/**
 * Filtre commun à toutes les mesures.
 *
 * `'me' in owners` n'est pas un détail : sans lui, les fichiers que d'autres
 * personnes partagent avec l'utilisateur entrent dans la somme alors qu'ils
 * n'occupent pas son quota. On obtenait des barres plus grosses que le compte
 * entier — 13 Go d'archives pour un compte à 6 Mo — sous une phrase affirmant
 * mesurer « vos fichiers ».
 */
const OWNED = "trashed = false and 'me' in owners";

/**
 * Requêtes par catégorie. Le type est déduit du `mimeType` côté Drive, ce qui
 * évite de télécharger le nom de chaque fichier.
 */
const QUERIES: { id: StorageCategoryId; query: string }[] = [
  { id: 'document', query: `${OWNED} and mimeType contains 'application/pdf'` },
  { id: 'image', query: `${OWNED} and mimeType contains 'image/'` },
  { id: 'video', query: `${OWNED} and mimeType contains 'video/'` },
  { id: 'audio', query: `${OWNED} and mimeType contains 'audio/'` },
  { id: 'archive', query: `${OWNED} and mimeType contains 'zip'` },
  { id: 'other', query: `${OWNED} and mimeType contains 'text/'` },
];

/**
 * Mesure la répartition par catégorie.
 *
 * `maxPages` borne le travail par catégorie : c'est le seul garde-fou contre un
 * compte de plusieurs centaines de milliers de fichiers.
 */
export async function readStorageUsage(
  endpoints: Endpoints,
  token: string,
  quota: DriveQuota,
  options: { maxPages?: number; signal?: AbortSignal } = {},
): Promise<StorageUsage> {
  const results = await Promise.all(
    QUERIES.map(async ({ id, query }) => {
      try {
        const sum = await sumBytes(endpoints, token, query, {
          maxPages: options.maxPages ?? 4,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        return { id, ...sum };
      } catch {
        // Une catégorie illisible ne doit pas vider tout l'écran.
        return { id, bytes: 0, count: 0, partial: true };
      }
    }),
  );

  // `usedBytes` est déjà le total du compte (voir readQuota).
  const total = quota.usageBytes ?? quota.usedBytes;
  const inDrive = quota.usageInDriveBytes ?? 0;
  const other = inDrive > 0 && total > inDrive ? total - inDrive : null;

  return {
    usedBytes: total,
    quotaBytes: quota.quotaBytes,
    // Un écart nul signifie que Google ne distingue pas encore les services :
    // afficher « 0 o dans Gmail » serait faux.
    emailBytes: other,
    categories: results,
    partial: results.some((category) => category.partial),
  };
}
