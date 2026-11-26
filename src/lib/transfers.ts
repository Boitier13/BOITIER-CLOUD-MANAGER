/**
 * Règles pures de la file de transferts, sans dépendance : elles servent au
 * démarrage de l'application et sont vérifiables hors navigateur.
 */

/**
 * Anciens dossiers de destination, écrits en dur dans les premières versions.
 *
 * Ils ne correspondaient à aucune machine : l'un désignait un lecteur `D:`
 * absent, un autre le profil d'un utilisateur qui n'existait pas. Le transfert
 * y échouait avant même d'ouvrir le flux, sans message.
 */
const LEGACY_FOLDERS = [
  'c:\\users\\boitier\\téléchargements',
  'c:\\users\\boitier\\vidéos\\cloud',
  'c:\\users\\boitier\\videos\\cloud',
  'd:\\médias\\téléchargements',
  'd:\\medias\\telechargements',
  'e:\\sauvegardes\\cloud',
];

export function isLegacyDownloadFolder(folder: string): boolean {
  return LEGACY_FOLDERS.includes(folder.trim().toLowerCase().replace(/\/+$/, ''));
}

/**
 * Transferts restaurés du stockage local au démarrage.
 *
 * Aucun processus ne les pilote plus : les laisser « En cours » produit une
 * ligne figée à 0 %, indiscernable d'un vrai blocage. Ils passent en échec avec
 * un motif, et le bouton « Réessayer » repart de zéro.
 */
export function interruptStaleDownloads<
  T extends { status: string; speed: number; error?: string },
>(items: T[]): T[] {
  return items.map((item) =>
    item.status === 'active' || item.status === 'paused' || item.status === 'queued'
      ? {
          ...item,
          status: 'error',
          speed: 0,
          error: 'Transfert interrompu : aucun téléchargement ne le pilotait plus. Relancez-le.',
        }
      : item,
  );
}
