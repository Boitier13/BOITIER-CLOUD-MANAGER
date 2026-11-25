/**
 * Catalogue des fournisseurs et modèles d'affichage.
 *
 * L'application ne présente plus de comptes fictifs : seuls les comptes
 * réellement connectés existent. La structure multi-fournisseurs est conservée
 * (identifiants, marques, quotas) afin qu'un second fournisseur puisse être
 * ajouté sans reconstruire l'interface.
 *
 * Aucune connexion réseau ici : ce fichier ne décrit que des métadonnées.
 */

/** Fournisseurs reconnus par l'application. Seul Google Drive est connecté. */
export type ProviderId = 'gdrive';

export type AccountStatus = 'connected' | 'syncing' | 'expired';

export type FileType =
  | 'folder'
  | 'video'
  | 'document'
  | 'image'
  | 'archive'
  | 'audio'
  | 'subtitle'
  | 'other';

export const KB = 1024;
export const MB = 1024 * KB;
export const GB = 1024 * MB;
export const TB = 1024 * GB;

export interface Provider {
  id: ProviderId;
  name: string;
  prefix: string;
  brand: string;
  quota: number;
  domain: string;
  tagline: string;
}

export const PROVIDERS: Record<ProviderId, Provider> = {
  gdrive: {
    id: 'gdrive',
    name: 'Google Drive',
    prefix: 'DRIVE',
    brand: '#6b93e0',
    quota: 200 * GB,
    domain: 'gmail.com',
    tagline: 'Documents et partages',
  },
};

export const PROVIDER_IDS: ProviderId[] = ['gdrive'];

export const PROVIDER_LIST: Provider[] = PROVIDER_IDS.map((id) => PROVIDERS[id]);

/** Origine du compte : toujours un fournisseur réel désormais. */
export type AccountSource = 'google';

export interface Account {
  id: string;
  provider: ProviderId;
  name: string;
  email: string;
  status: AccountStatus;
  usedBytes: number;
  quotaBytes: number;
  createdAt: string;
  /** Conservé pour la compatibilité de l'état stocké des versions précédentes. */
  seed: number;
  source?: AccountSource;
  /** Identifiant du compte côté Google (jamais un jeton). */
  googleId?: string;
  /** Photo de profil fournie par Google. */
  avatarUrl?: string;
  /** Espace utilisé provenant des autres fournisseurs (offres professionnelles). */
  usageByProvider?: Partial<Record<ProviderId, number>>;
  /** `false` : aucun catalogue fictif, les fichiers viennent du cloud réel. */
  localTree?: boolean;
}

export interface FileNode {
  id: string;
  name: string;
  type: FileType;
  size: number;
  modified: string;
  children?: FileNode[];
}

/* ----------------------------------------------------------------------------
 * Détection du type de fichier
 * ------------------------------------------------------------------------- */

const EXT_TYPES: Record<string, FileType> = {
  mkv: 'video',
  mp4: 'video',
  avi: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',
  md: 'document',
  txt: 'document',
  csv: 'document',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'image',
  gif: 'image',
  heic: 'image',
  svg: 'image',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  iso: 'archive',
  bin: 'archive',
  dmg: 'archive',
  mp3: 'audio',
  flac: 'audio',
  wav: 'audio',
  m4a: 'audio',
  srt: 'subtitle',
  vtt: 'subtitle',
  fig: 'other',
  exe: 'other',
};

export function detectType(name: string): FileType {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return 'other';
  return EXT_TYPES[name.slice(dot + 1).toLowerCase()] ?? 'other';
}

/* ----------------------------------------------------------------------------
 * Aides à la création d'un compte
 * ------------------------------------------------------------------------- */
