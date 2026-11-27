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
const triNomsMega = new Intl.Collator('fr');

export function sortRemoteFiles(files: RemoteFile[]): RemoteFile[] {
  // Normaliser une fois par fichier, pas à chaque comparaison du tri.
  return files.map((file) => ({
    file,
    cle: file.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(),
  })).sort((a, b) => {
    if (a.file.kind !== b.file.kind) return a.file.kind === 'folder' ? -1 : 1;
    return triNomsMega.compare(a.cle, b.cle);
  }).map(({ file }) => file);
}

/**
 * Codes d'erreur MEGA, par nom.
 *
 * `megajs` ne joint pas toujours le code numérique : l'erreur arrive sous la
 * forme `EBLOCKED (-16): User blocked`, avec le code **dans le texte**. Sans
 * cette table, l'écran affichait ce texte brut à la place d'une explication.
 */
const CODES_MEGA: Record<string, number> = {
  EINTERNAL: 1,
  EARGS: 2,
  EAGAIN: 3,
  ERATELIMIT: 4,
  ENOENT: 9,
  EACCESS: 11,
  ESID: 15,
  EEXPIRED: 8,
  EBLOCKED: 16,
  EOVERQUOTA: 17,
  ETEMPUNAVAIL: 18,
  ETOOMANY: 6,
  ETOOMANYCONNECTIONS: 19,
  EGOINGOVERQUOTA: 24,
  EMFAREQUIRED: 26,
};

/**
 * Code numérique d'une erreur MEGA, même quand il n'est que dans le texte.
 *
 * L'erreur réelle observée en usage était `EBLOCKED (-16): User blocked` :
 * `cause.code` valait `undefined`, donc le message restait en anglais et
 * parlait de « Google Drive ».
 */
export function codeErreurMega(cause: unknown): number {
  const direct = Number((cause as { code?: number } | null)?.code ?? 0);
  if (Number.isFinite(direct) && direct !== 0) return Math.abs(direct);
  const texte = (cause as Error | null)?.message ?? '';
  const numerique = /\(\s*-?(\d{1,3})\s*\)/.exec(texte);
  if (numerique) return Math.abs(Number(numerique[1]));
  const nom = /\b(E[A-Z_]{3,})\b/.exec(texte);
  if (nom && CODES_MEGA[nom[1]] !== undefined) return CODES_MEGA[nom[1]];
  return 0;
}

/** Message lisible pour une erreur MEGA. */
export function messageErreurMega(cause: unknown): string {
  const code = codeErreurMega(cause);
  const messages: Record<number, string> = {
    1: 'MEGA signale une erreur interne, réessayez plus tard',
    2: 'MEGA a refusé la demande de connexion ou ses paramètres',
    3: 'MEGA est momentanément indisponible, réessayez dans un instant',
    4: 'trop de requêtes envoyées à MEGA, réessayez dans quelques secondes',
    6: 'trop de connexions simultanées vers MEGA',
    8: 'Le lien de transfert MEGA a expiré : relancez le transfert',
    9: 'élément ou compte MEGA introuvable : vérifiez l’adresse et le mot de passe si vous vous connectez',
    11: 'accès refusé par MEGA sur cet élément',
    15: 'session MEGA expirée : reconnectez ce compte',
    16: 'MEGA indique que ce compte est bloqué : patientez avant de réessayer. Si le blocage persiste, contactez l’assistance MEGA.',
    17: 'quota de transfert MEGA épuisé pour aujourd’hui',
    18: 'MEGA est temporairement indisponible, réessayez plus tard',
    19: 'trop de connexions simultanées vers MEGA',
    24: 'cette opération dépasserait le quota de votre compte MEGA',
    26: 'vérification en deux étapes requise',
  };
  if (code && messages[code]) return messages[code];
  const brut = (cause as Error | null)?.message ?? '';
  if (/invalid credentials|wrong password/i.test(brut)) return 'Adresse ou mot de passe MEGA incorrect : vérifiez-les et réessayez.';
  if (/account version not supported/i.test(brut)) return 'Cette version de compte MEGA n’est pas prise en charge par la bibliothèque de connexion.';
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|network/i.test(brut)) return 'Connexion à MEGA impossible : vérifiez votre réseau et réessayez.';
  if (/^fichier MEGA introuvable$/i.test(brut)) return brut;
  return 'L’opération MEGA a échoué pour une raison inconnue. Consultez le journal de démarrage.';
}

/** Vrai si l'erreur signifie « il faut un code de vérification ». */
export function exigeDeuxEtapes(cause: unknown): boolean {
  if (codeErreurMega(cause) === 26) return true;
  return /EMFAREQUIRED|multi-f.?factor|two-factor|2fa/i.test(
    (cause as Error | null)?.message ?? '',
  );
}

/** Vrai si l'erreur signifie « session à renouveler ». */
export function sessionExpiree(cause: unknown): boolean {
  if (codeErreurMega(cause) === 15) return true;
  return /ESID/i.test((cause as Error | null)?.message ?? '');
}
