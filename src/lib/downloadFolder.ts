/**
 * Dossier qui rassemble tous les téléchargements de l'application.
 *
 * Module **sans aucun import** : il est utilisé par l'interface *et* par le
 * processus principal, dont la résolution de modules exige des chemins
 * explicites.
 *
 * Sans ce dossier, les fichiers arrivent directement dans `Téléchargements`,
 * mêlés au reste : impossible de retrouver ce qui vient des clouds, ni de faire
 * de place d'un coup. Tout est donc écrit sous
 * `<Téléchargements>/BOITIER-CLOUD-MANAGER/<cloud>/<nature>`.
 */

export const APP_DOWNLOAD_FOLDER = 'BOITIER-CLOUD-MANAGER';

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

/** Dossier de téléchargement par défaut, à partir du dossier système. */
export function defaultDownloadDir(systemDownloads: string): string {
  return joinFolder(systemDownloads, APP_DOWNLOAD_FOLDER);
}
