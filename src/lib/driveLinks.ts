/**
 * Liens vers Google Drive, pour déléguer ce que l'application ne fait pas.
 *
 * L'application lit les Drive et n'écrit jamais : téléverser, renommer ou
 * supprimer se fait donc dans Google Drive lui-même. Plutôt que de laisser
 * l'utilisateur retrouver son dossier à la main, on l'y emmène directement.
 *
 * Module sans dépendance : il est partagé par l'interface et par le processus
 * principal, qui s'en sert pour n'autoriser que ces adresses-là.
 */

const CONSOLE_LINKS = /^https:\/\/(console\.cloud\.google\.com|developers\.google\.com)\//;
const DRIVE_LINKS = /^https:\/\/drive\.google\.com\//;

/** Dossier du compte (racine si `folderId` désigne la racine). */
export function driveFolderUrl(folderId: string): string {
  const id = folderId.trim();
  if (!id || id === 'root') return 'https://drive.google.com/drive/my-drive';
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

export function driveFileUrl(fileId: string): string {
  const id = fileId.trim();
  if (!id) return 'https://drive.google.com/drive/my-drive';
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
}

/**
 * Seules ces adresses partent vers le navigateur : configuration Google et
 * Google Drive. Une adresse forgée par une réponse piégée est refusée.
 */
export function isAllowedExternalUrl(url: string): boolean {
  return CONSOLE_LINKS.test(url) || DRIVE_LINKS.test(url);
}
