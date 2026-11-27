/**
 * Aiguillage entre fournisseurs côté interface.
 *
 * Le reste de l'application ne sait pas — et ne doit pas savoir — si un compte
 * vient de Google ou de MEGA : elle parle de dossiers, de fichiers et de
 * transferts. Ce module est le seul endroit qui décide quel pont appeler.
 *
 * Les comptes MEGA sont reconnus à leur identifiant d'application
 * (`mega-real-…`) : il est créé par l'application, il ne dépend donc pas d'un
 * identifiant propre au fournisseur.
 */

import type { Account, ProviderId } from '../data/catalog';
import {
  getBridge,
  type GoogleDownloadRequest,
  type GoogleFile,
  type GoogleFolderPlan,
  type MegaAccountInfo,
  type MegaUploadEvent,
} from './bridge';

/**
 * Fournisseur de chaque compte, indexé par identifiant côté fournisseur.
 *
 * L'identifiant d'un compte MEGA est un handle opaque : impossible d'en déduire
 * le fournisseur. Le registre est rempli depuis l'état de l'application — c'est
 * le seul moyen fiable de router un appel alors que l'explorateur ne manipule,
 * partout ailleurs, qu'un identifiant de compte.
 */
const fournisseurs = new Map<string, ProviderId>();

/** Tient le registre à jour (appelé quand la liste des comptes change). */
export function registerAccountProviders(accounts: Account[]): void {
  fournisseurs.clear();
  for (const account of accounts) {
    const identifiant = account.provider === 'mega' ? (account.megaId ?? account.id) : account.provider === 'shadow' ? (account.shadowId ?? account.id) : (account.googleId ?? account.id);
    fournisseurs.set(identifiant, account.provider);
    fournisseurs.set(account.id, account.provider);
  }
}

/** Fournisseur d'un compte, par son identifiant côté fournisseur. */
export function providerOf(accountId: string): ProviderId {
  const connu = fournisseurs.get(accountId);
  if (connu) return connu;
  // Repli : les identifiants d'application MEGA commencent par « mega ».
  return accountId.startsWith('mega') ? 'mega' : accountId.startsWith('shadow') ? 'shadow' : 'gdrive';
}

/** Vrai si le pont MEGA est disponible (application Windows). */
export function hasMega(): boolean {
  return Boolean(getBridge()?.mega);
}

/** Contenu d'un dossier, quel que soit le fournisseur. */
export async function listFolder(accountId: string, folderId: string): Promise<GoogleFile[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  if (providerOf(accountId) === 'shadow') {
    if (!bridge.shadow) throw new Error('Shadow Drive n’est disponible que dans l’application Windows.');
    return bridge.shadow.list(accountId, folderId);
  }
  if (providerOf(accountId) === 'mega') {
    if (!bridge.mega) throw new Error('MEGA n’est disponible que dans l’application Windows.');
    // « root » est l'alias racine de Google ; MEGA désigne sa racine par vide.
    return bridge.mega.list(accountId, folderId === 'root' ? '' : folderId);
  }
  return bridge.google.list(accountId, folderId);
}

/** Recherche par nom dans un compte. */
export async function searchAccount(accountId: string, term: string): Promise<GoogleFile[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  if (providerOf(accountId) === 'shadow') {
    if (!bridge.shadow) throw new Error('Shadow Drive indisponible.');
    return bridge.shadow.search(accountId, term);
  }
  if (providerOf(accountId) === 'mega') {
    if (!bridge.mega) return [];
    return bridge.mega.search(accountId, term);
  }
  return bridge.google.search(accountId, term);
}

/** Derniers fichiers modifiés d'un compte. */
export async function recentAccount(
  accountId: string,
  options?: { days?: number; limit?: number },
): Promise<GoogleFile[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  if (providerOf(accountId) === 'shadow') {
    if (!bridge.shadow) throw new Error('Shadow Drive indisponible.');
    return bridge.shadow.recent(accountId, options?.limit);
  }
  if (providerOf(accountId) === 'mega') {
    if (!bridge.mega) return [];
    return bridge.mega.recent(accountId, options?.limit ?? 200);
  }
  return bridge.google.recent(accountId, options);
}

/**
 * Éléments partagés avec le compte.
 *
 * MEGA n'expose pas d'équivalent au « partagé avec moi » de Drive : la liste
 * est vide plutôt qu'en erreur, pour ne pas afficher un échec là où il n'y a
 * simplement rien à montrer.
 */
export async function sharedAccount(accountId: string): Promise<GoogleFile[]> {
  const bridge = getBridge();
  if (!bridge) return [];
  if (providerOf(accountId) !== 'gdrive') return [];
  return bridge.google.shared(accountId);
}

/** Parcours d'un dossier : plan de téléchargement, sans rien écrire. */
export async function planFolder(
  accountId: string,
  folderId: string,
): Promise<GoogleFolderPlan> {
  const bridge = getBridge();
  if (!bridge) throw new Error('Le parcours d’un dossier demande la version Windows.');
  if (providerOf(accountId) === 'shadow') {
    if (!bridge.shadow) throw new Error('Shadow Drive indisponible.');
    return bridge.shadow.plan(accountId, folderId);
  }
  if (providerOf(accountId) === 'mega') {
    if (!bridge.mega) throw new Error('MEGA n’est disponible que dans l’application Windows.');
    return bridge.mega.plan(accountId, folderId === 'root' ? '' : folderId);
  }
  return bridge.google.plan(accountId, folderId);
}

/** Lance un téléchargement réel (le processus principal écrit sur le disque). */
export async function downloadAccount(
  request: GoogleDownloadRequest & { provider?: ProviderId },
): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  if ((request.provider ?? providerOf(request.accountId)) === 'shadow') {
    if (!bridge.shadow) throw new Error('Shadow Drive indisponible.');
    return bridge.shadow.download(request);
  }
  if ((request.provider ?? providerOf(request.accountId)) === 'mega') {
    if (!bridge.mega) throw new Error('MEGA n’est disponible que dans l’application Windows.');
    return bridge.mega.download(request);
  }
  return bridge.google.download(request);
}

export async function pauseTransfer(provider: ProviderId, id: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  if (provider === 'shadow') return bridge.shadow?.pause(id);
  if (provider === 'mega') return bridge.mega?.pause(id);
  return bridge.google.pause(id);
}

export async function resumeTransfer(
  provider: ProviderId,
  id: string,
  remoteAccount?: string,
): Promise<boolean | void> {
  const bridge = getBridge();
  if (!bridge) return false;
  if (provider === 'shadow') return bridge.shadow?.resume(id);
  if (provider === 'mega') return bridge.mega?.resume(id);
  return bridge.google.resume(id, remoteAccount ?? '');
}

export async function cancelTransfer(provider: ProviderId, id: string): Promise<void> {
  const bridge = getBridge();
  if (!bridge) return;
  if (provider === 'shadow') return bridge.shadow?.cancel(id);
  if (provider === 'mega') return bridge.mega?.cancel(id);
  return bridge.google.cancel(id);
}

/** Comptes MEGA connus du processus principal (aucune requête réseau). */
export async function megaAccounts(): Promise<MegaAccountInfo[]> {
  const bridge = getBridge();
  if (!bridge?.mega) return [];
  try {
    return await bridge.mega.accounts();
  } catch {
    return [];
  }
}

/** Ouvre la boîte de dialogue d'envoi, puis téléverse vers MEGA. */
export async function uploadToMega(
  accountId: string,
  folderId: string,
): Promise<{ sent: number }> {
  const bridge = getBridge();
  if (!bridge?.mega) throw new Error('MEGA n’est disponible que dans l’application Windows.');
  return bridge.mega.upload(accountId, folderId);
}

/** Suit la progression des téléversements MEGA. */
export function onMegaUpload(listener: (event: MegaUploadEvent) => void): () => void {
  const bridge = getBridge();
  // Un pont incomplet ne doit jamais emporter l'interface : une méthode absente
  // signifie « aucun événement à suivre », pas « écran interrompu ».
  if (typeof bridge?.mega?.onUpload !== 'function') return () => undefined;
  return bridge.mega.onUpload(listener);
}
