/**
 * Traduction entre les objets MEGA et ceux de l'application.
 *
 * Aucune connexion réseau ici : uniquement des fonctions pures, donc
 * vérifiables sans compte ni serveur. Le reste du processus principal ne
 * manipule jamais un nœud `megajs` directement.
 */

/** Ce que l'interface sait afficher d'un fichier, quel que soit le fournisseur. */
export interface RemoteFile {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  mimeType: string;
  size: number;
  modified: string;
  parentId?: string;
}

/** Sous-ensemble d'un nœud `megajs` réellement utilisé ici. */
export interface MegaNodeLike {
  nodeId?: string;
  downloadId?: string;
  name?: string | null;
  label?: string | null;
  size?: number;
  directory?: boolean;
  timestamp?: number;
  parent?: { nodeId?: string } | null;
}

/**
 * Types MIME des extensions courantes.
 *
 * MEGA ne transmet pas de type : le nom du fichier est la seule information.
 * L'interface retombe de toute façon sur l'extension (`detectType`), cette
 * table sert surtout aux aperçus et aux filtres qui lisent le type MIME.
 */
const MIME_PAR_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  txt: 'text/plain',
  srt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Type MIME déduit de l'extension ; `application/octet-stream` sinon. */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME_PAR_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Convertit un nœud MEGA en fichier affichable.
 *
 * L'identifiant exposé est le `nodeId` MEGA : c'est ce que le processus
 * principal sait retrouver dans `storage.files` pour télécharger ou naviguer.
 */
export function toRemoteFile(node: MegaNodeLike, parentId?: string): RemoteFile {
  const name = node.name || node.label || 'Sans nom';
  const directory = node.directory === true;
  const parent = parentId ?? node.parent?.nodeId;
  const modified =
    typeof node.timestamp === 'number' && node.timestamp > 0
      ? new Date(node.timestamp * 1000).toISOString()
      : new Date(0).toISOString();
  return {
    id: node.nodeId ?? node.downloadId ?? name,
    name,
    kind: directory ? 'folder' : 'file',
    mimeType: directory ? 'mega/folder' : mimeFromName(name),
    size: directory ? 0 : Math.max(0, Number(node.size) || 0),
    modified,
    ...(parent ? { parentId: parent } : {}),
  };
}

/** Tri d'affichage : dossiers d'abord, puis par nom, accents ignorés. */
export function sortRemoteFiles(files: RemoteFile[]): RemoteFile[] {
  const cle = (file: RemoteFile) =>
    file.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  return [...files].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return cle(a).localeCompare(cle(b), 'fr');
  });
}

/**
 * Message lisible pour une erreur MEGA.
 *
 * Les codes négatifs de l'API sont traduits : sans cela, l'utilisateur voyait
 * « -17 » au lieu de « quota de transfert épuisé », qui est pourtant l'erreur
 * la plus fréquente sur un compte gratuit.
 */
export function messageErreurMega(cause: unknown): string {
  const code = Math.abs(Number((cause as { code?: number } | null)?.code ?? 0));
  const messages: Record<number, string> = {
    3: 'MEGA est momentanément indisponible, réessayez dans un instant',
    4: 'trop de requêtes envoyées à MEGA, réessayez dans quelques secondes',
    9: 'adresse ou mot de passe MEGA incorrect',
    11: 'accès refusé par MEGA sur cet élément',
    15: 'session MEGA expirée : reconnectez ce compte',
    16: 'MEGA bloque temporairement ce compte (trop de connexions) : patientez quelques minutes',
    17: 'quota de transfert MEGA épuisé pour aujourd’hui',
    18: 'MEGA est temporairement indisponible, réessayez plus tard',
    19: 'trop de connexions simultanées vers MEGA',
    24: 'cette opération dépasserait le quota de votre compte MEGA',
    26: 'vérification en deux étapes requise',
  };
  if (code && messages[code]) return messages[code];
  const brut = (cause as Error | null)?.message ?? '';
  return brut || 'MEGA n’a pas répondu';
}

/** Vrai si l'erreur signifie « il faut un code de vérification ». */
export function exigeDeuxEtapes(cause: unknown): boolean {
  const code = Math.abs(Number((cause as { code?: number } | null)?.code ?? 0));
  if (code === 26) return true;
  return /EMFAREQUIRED|multi-f.?factor|two-factor|2fa/i.test(
    (cause as Error | null)?.message ?? '',
  );
}

/** Vrai si l'erreur signifie « session à renouveler ». */
export function sessionExpiree(cause: unknown): boolean {
  const code = Math.abs(Number((cause as { code?: number } | null)?.code ?? 0));
  if (code === 15) return true;
  return /ESID/i.test((cause as Error | null)?.message ?? '');
}
