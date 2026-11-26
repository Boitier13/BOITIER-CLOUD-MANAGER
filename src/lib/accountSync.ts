/**
 * Fusion de la liste des comptes avec ce que renvoie le coffre.
 *
 * Extrait du reducer pour être vérifiable : la règle a déjà coûté cher. La
 * synchronisation Google retire de l'écran les comptes Google absents du coffre
 * — mais elle ne doit **jamais** toucher aux autres fournisseurs. Une condition
 * trop large (`!isRealAccount(account)`) effaçait les comptes MEGA à chaque
 * démarrage, dès lors que MEGA est devenu un fournisseur réel.
 */

import type { Account } from '../data/catalog';
import { isRealAccount } from './google';

/** Comptes Google présents dans la liste, quel que soit leur état. */
export function googleAccountsOf(accounts: Account[]): Account[] {
  return accounts.filter((account) => account.provider === 'gdrive' && isRealAccount(account));
}

/**
 * Applique une liste fraîche de comptes Google à la liste courante.
 *
 * - les comptes Google connus sont mis à jour, les nouveaux ajoutés ;
 * - les comptes Google disparus du coffre sont retirés ;
 * - **tous les autres comptes sont conservés tels quels** (MEGA, futurs
 *   fournisseurs, comptes sans fournisseur distinct).
 *
 * Une liste `fresh` vide est traitée comme « le coffre est vide », et non comme
 * « je ne sais pas » : c'est à l'appelant de passer `null` quand l'appel a
 * échoué, et de ne rien faire dans ce cas.
 */
export function mergeSyncedAccounts(current: Account[], fresh: Account[]): Account[] {
  const next = [...current];
  for (const account of fresh) {
    const index = next.findIndex((item) => item.id === account.id);
    if (index >= 0) next[index] = { ...next[index], ...account };
    else next.push(account);
  }
  const connus = new Set(fresh.map((account) => account.id));
  return next.filter(
    (account) =>
      account.provider !== 'gdrive' || !isRealAccount(account) || connus.has(account.id),
  );
}
