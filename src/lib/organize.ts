/**
 * Rangement des téléchargements par cloud et par nature de fichier.
 *
 * Un dossier unique finit par contenir des vidéos, des factures et des
 * archives, indiscernables. Chaque transfert est donc rangé dans
 * `<dossier de base>\<cloud>\<nature>` — par exemple :
 * `C:\Users\…\Downloads\Google Drive\Vidéos`.
 *
 * Module sans dépendance d'exécution : les types seuls sont importés, ce qui
 * permet de le vérifier hors navigateur.
 */

import type { FileType, ProviderId } from '../data/catalog';

/** Dossiers visibles par l'utilisateur, au pluriel et en français. */
const TYPE_FOLDER: Record<FileType, string> = {
  video: 'Vidéos',
  audio: 'Audio',
  image: 'Images',
  document: 'Documents',
  archive: 'Archives',
  subtitle: 'Sous-titres',
  folder: 'Dossiers',
  other: 'Autres',
};

export function categoryFolder(type: FileType): string {
  return TYPE_FOLDER[type] ?? 'Autres';
}

/** Nom du dossier de cloud. Écrit ici pour ne pas dépendre du catalogue. */
const CLOUD_FOLDER: Record<ProviderId, string> = {
  gdrive: 'Google Drive',
};

/** Nom du dossier de cloud, pour les téléchargements de dossiers entiers. */
export function cloudFolder(provider: ProviderId): string {
  return CLOUD_FOLDER[provider] ?? 'Cloud';
}

/**
 * Sous-dossier d'un fichier téléchargé depuis un cloud donné.
 *
 * `undefined` quand le rangement est désactivé : le fichier va alors
 * directement dans le dossier de base.
 */
export function downloadSubPath(
  provider: ProviderId,
  type: FileType,
  organize = true,
): string | undefined {
  if (!organize) return undefined;
  return `${CLOUD_FOLDER[provider] ?? 'Cloud'}/${categoryFolder(type)}`;
}

/**
 * Assemble un chemin Windows ou POSIX sans doubler les séparateurs.
 *
 * Le séparateur suit celui du dossier de base : `C:\…` reçoit des `\`,
 * `/home/…` des `/`.
 */
export function joinFolder(base: string, subPath?: string): string {
  const cleanBase = base.trim().replace(/[\\/]+$/, '');
  const parts = (subPath ?? '').split('/').filter(Boolean);
  if (!parts.length) return cleanBase;
  const separator = cleanBase.includes('\\') ? '\\' : '/';
  return [cleanBase, ...parts].filter(Boolean).join(separator);
}
