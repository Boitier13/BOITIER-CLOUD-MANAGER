/**
 * Parcours d'un dossier Drive pour préparer un téléchargement en lot.
 *
 * Cette marche d'arbre vit dans le processus principal, pas dans l'interface :
 * un dossier peut contenir des milliers d'éléments, et l'interface n'a pas à
 * connaître la structure complète avant que le transfert commence. On ne
 * rapatrie que des métadonnées (chemin relatif, identifiant, taille).
 *
 * Rien n'est écrit ici : l'écriture reste le travail du gestionnaire de
 * téléchargements, qui refuse un fichier natif Google et ne laisse jamais de
 * fichier tronqué présenté comme complet.
 */

import { listChildren, type DriveItem } from './drive.ts';
import type { Endpoints } from './endpoints.ts';

export type PlannedFile = {
  fileId: string;
  /** Chemin relatif au dossier choisi, séparé par `/`. */
  path: string;
  size: number;
  mimeType: string;
};

export type FolderPlan = {
  files: PlannedFile[];
  /** Dossiers rencontrés, chemins relatifs (pour créer l'arborescence). */
  folders: string[];
  /** Documents Google natifs écartés : ils n'ont pas de fichier binaire. */
  skipped: string[];
  /** Vrai si la limite de sécurité a été atteinte : le lot est incomplet. */
  truncated: boolean;
  totalBytes: number;
};

/** Garde-fous : au-delà, on renvoie un plan partiel et on le dit. */
const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const MAX_FOLDERS = 500;

const isGoogleNative = (mimeType: string) => mimeType.startsWith('application/vnd.google-apps.');

/**
 * Liste récursivement le contenu de `folderId`.
 *
 * Les erreurs d'un sous-dossier n'interrompent pas tout : on continue avec le
 * reste et le fichier fautif n'apparaît simplement pas dans le plan.
 */
export async function planFolder(
  endpoints: Endpoints,
  token: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<FolderPlan> {
  const plan: FolderPlan = {
    files: [],
    folders: [],
    skipped: [],
    truncated: false,
    totalBytes: 0,
  };

  const walk = async (id: string, prefix: string[], depth: number): Promise<void> => {
    if (plan.files.length >= MAX_FILES || plan.folders.length >= MAX_FOLDERS) {
      plan.truncated = true;
      return;
    }
    const items: DriveItem[] = await listChildren(endpoints, token, id, signal);

    for (const item of items) {
      if (signal?.aborted) return;
      const relative = [...prefix, item.name];

      if (item.kind === 'folder') {
        if (plan.folders.length >= MAX_FOLDERS) {
          plan.truncated = true;
          return;
        }
        plan.folders.push(relative.join('/'));
        // Un dossier trop profond n'est pas parcouru : on le signale plutôt que
        // de produire une arborescence que le disque refuserait de toute façon.
        if (depth + 1 >= MAX_DEPTH) {
          plan.truncated = true;
          continue;
        }
        await walk(item.id, relative, depth + 1);
        continue;
      }

      if (isGoogleNative(item.mimeType)) {
        plan.skipped.push(relative.join('/'));
        continue;
      }
      if (plan.files.length >= MAX_FILES) {
        plan.truncated = true;
        return;
      }
      plan.files.push({
        fileId: item.id,
        path: relative.join('/'),
        size: item.size,
        mimeType: item.mimeType,
      });
      plan.totalBytes += item.size;
    }
  };

  await walk(folderId, [], 0);
  return plan;
}
