/**
 * Couche Google côté interface.
 *
 * Elle ne connaît ni jetons ni secrets : tout passe par le pont Electron.
 * Dans un navigateur, chaque helper renvoie `null`/`false` : l'application
 * affiche alors un état vide invitant à utiliser la version Windows.
 */

import { detectType, GB, type Account, type FileNode, type FileType } from '../data/catalog';
import { suggestedName } from './accounts';
import { getBridge, type GoogleAccountInfo, type GoogleFile } from './bridge';

export const GOOGLE_ROOT = 'root';

/**
 * Un compte est réel lorsqu'il correspond à une session chez un fournisseur.
 *
 * Le nom de la fonction est historique : elle couvre désormais Google **et**
 * MEGA, parce que tout l'explorateur s'appuie dessus pour savoir s'il doit
 * demander le contenu au processus principal plutôt qu'à une arborescence
 * locale.
 */
export function isRealAccount(account: Account): boolean {
  return (
    (account.provider === 'gdrive' && account.source === 'google') ||
    (account.provider === 'mega' && account.source === 'mega')
  );
}

/** Identifiant du compte côté fournisseur (jamais un secret). */
export function realAccountId(account: Account): string | undefined {
  if (account.provider === 'mega') return account.megaId ?? account.id;
  return account.googleId ?? (account.source === 'google' ? account.id : undefined);
}

/** Comptes Google détectés côté processus principal. */
export async function probeAccounts(): Promise<GoogleAccountInfo[]> {
  return (await probeAccountsStrict()) ?? [];
}

/**
 * Comme `probeAccounts`, mais distingue « aucun compte » de « l'appel a échoué ».
 *
 * La distinction n'est pas cosmétique : la synchronisation retire de l'écran les
 * comptes Google absents de la liste renvoyée. Sur un échec, une liste vide
 * ferait donc disparaître tous les comptes — alors que le coffre est intact.
 * `null` signifie « je ne sais pas », et la synchronisation s'abstient.
 */
export async function probeAccountsStrict(): Promise<GoogleAccountInfo[] | null> {
  const bridge = getBridge();
  if (!bridge) return null;
  try {
    return await bridge.google.accounts();
  } catch {
    return null;
  }
}

/** Écrit une ligne dans le journal de démarrage, si le pont le permet. */
export function noteJournal(message: string): void {
  try {
    getBridge()?.note?.(message);
  } catch {
    /* journal indisponible : ce n'est jamais une raison d'échouer */
  }
}

/** Compte existant correspondant à une entrée du coffre. */
function existingFor(accounts: Account[], info: GoogleAccountInfo): Account | undefined {
  return (
    accounts.find((account) => isRealAccount(account) && account.googleId === info.accountId) ??
    accounts.find(
      (account) => account.provider === 'gdrive' && account.email === info.email,
    )
  );
}

/**
 * Lit le coffre et applique la liste à l'état de l'application.
 *
 * Lève si l'appel échoue, au lieu de renvoyer une liste vide : c'est à
 * l'appelant de décider quoi faire d'un échec, et de réessayer. Une lecture
 * impossible ne doit jamais passer pour « aucun compte ».
 */
export async function syncGoogleAccounts(
  accounts: Account[],
  dispatch: (action: { type: 'account/sync'; accounts: Account[] }) => void,
): Promise<{ received: number }> {
  const bridge = getBridge();
  if (!bridge) throw new Error('pont indisponible');
  const infos = await bridge.google.accounts();
  dispatch({
    type: 'account/sync',
    accounts: infos.map((info) => toAccount(info, existingFor(accounts, info))),
  });
  return { received: infos.length };
}

/**
 * Convertit un compte Google en compte d'application.
 * `usedBytes`/`quotaBytes` proviennent du quota réel ; un quota illimité
 * (compte professionnel) est affiché avec la valeur déjà connue de l'app.
 */
export function toAccount(info: GoogleAccountInfo, existing?: Account): Account {
  const previous = existing?.usageByProvider?.gdrive ?? 0;
  /**
   * Nom affiché : un renommage manuel est conservé, tout le reste suit la
   * suggestion. Sans cette règle, les comptes déjà connectés gardaient
   * « saturnin youkpo » jusqu'à un renommage à la main.
   */
  const auto = suggestedName(info);
  const manual =
    existing?.name && existing.name !== info.name && existing.name !== auto
      ? existing.name
      : undefined;
  return {
    id: existing?.id ?? `gdrive-real-${info.accountId}`,
    provider: 'gdrive',
    name: manual ?? auto,
    email: info.email,
    status: info.status,
    usedBytes: info.usedBytes,
    quotaBytes: info.quotaBytes || existing?.quotaBytes || 200 * GB,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    ...(info.authorizedAt ? { authorizedAt: info.authorizedAt } : {}),
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
