/**
 * Couche Google côté interface.
 *
 * Elle ne connaît ni jetons ni secrets : tout passe par le pont Electron.
 * Dans un navigateur, chaque helper renvoie `null`/`false` et l'application
 * continue de fonctionner avec ses comptes de démonstration.
 */

import { detectType, GB, type Account, type FileNode, type FileType } from '../data/catalog';
import { getBridge, type GoogleAccountInfo, type GoogleFile } from './bridge';

export const GOOGLE_ROOT = 'root';

/** Un compte est réel lorsqu'il vient de Google et non des données fictives. */
export function isRealAccount(account: Account): boolean {
  return account.provider === 'gdrive' && account.source === 'google';
}

export function realAccountId(account: Account): string | undefined {
  return account.googleId ?? (account.source === 'google' ? account.id : undefined);
}

/** Comptes Google détectés côté processus principal. */
export async function probeAccounts(): Promise<GoogleAccountInfo[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  try {
    return await bridge.google.accounts();
  } catch {
    return [];
  }
}

/**
 * Convertit un compte Google en compte d'application.
 * `usedBytes`/`quotaBytes` proviennent du quota réel ; un quota illimité
 * (compte professionnel) est affiché avec la valeur déjà connue de l'app.
 */
export function toAccount(info: GoogleAccountInfo, existing?: Account): Account {
  const previous = existing?.usageByProvider?.gdrive ?? 0;
  return {
    id: existing?.id ?? `gdrive-real-${info.accountId}`,
    provider: 'gdrive',
    name: existing?.name ?? info.name,
    email: info.email,
    status: info.status,
    usedBytes: info.usedBytes,
    quotaBytes: info.quotaBytes || existing?.quotaBytes || 200 * GB,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    seed: existing?.seed ?? 7,
    source: 'google',
    googleId: info.accountId,
    ...(info.picture ? { avatarUrl: info.picture } : {}),
    ...(existing?.usageByProvider ? { usageByProvider: existing.usageByProvider } : {}),
    // Pas de catalogue fictif : le contenu vient de Drive à la demande.
    localTree: false,
    ...(previous ? {} : {}),
  };
}

/** Mime Google natif → type d'affichage. */
const GOOGLE_MIME_TYPES: Record<string, FileType> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'document',
  'application/vnd.google-apps.presentation': 'document',
  'application/vnd.google-apps.drawing': 'image',
  'application/vnd.google-apps.script': 'other',
  'application/vnd.google-apps.form': 'document',
  'application/vnd.google-apps.site': 'other',
};

export function fileTypeOf(file: GoogleFile): FileType {
  if (file.kind === 'folder') return 'folder';
  return GOOGLE_MIME_TYPES[file.mimeType] ?? detectType(file.name);
}

/**
 * Convertit un fichier Drive en nœud d'affichage.
 *
 * - Les dossiers portent un tableau `children` vide : c'est le marqueur utilisé
 *   partout dans l'interface pour distinguer un dossier d'un fichier.
 * - Les documents Google natifs n'ont pas de taille binaire : la taille réelle
 *   n'apparaît qu'après export, on affiche donc 0 (l'interface écrit « — »).
 */
export function toNode(file: GoogleFile): FileNode {
  const base = {
    id: file.id,
    name: file.name,
    type: fileTypeOf(file),
    size: file.kind === 'folder' ? 0 : file.size,
    modified: file.modified,
  };
  return file.kind === 'folder' ? { ...base, children: [] } : base;
}

/** Renvoie `null` si le pont est absent (navigateur). */
export function bridge() {
  return getBridge();
}
