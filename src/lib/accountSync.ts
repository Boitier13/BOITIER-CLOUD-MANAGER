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
 * Règle unique, et volontairement pauvre : **la synchronisation ne fait
 * qu'ajouter et mettre à jour**. Elle ne retire jamais rien.
 *
 * C'est la leçon de l'incident : toute soustraction fondée sur « le coffre ne
 * mentionne plus ce compte » se trompe un jour — appel échoué, coffre illisible,
 * compte pas encore écrit, autre fournisseur confondu — et le compte disparaît
 * de l'écran alors que ses jetons sont toujours sur le disque. La seule
 * disparition légitime est une déconnexion demandée par l'utilisateur, qui
 * retire le compte du disque *et* de la liste au même moment.
 */
export function mergeSyncedAccounts(current: Account[], fresh: Account[]): Account[] {
  const next = [...current];
  for (const account of fresh) {
    const index = next.findIndex((item) => item.id === account.id);
    if (index >= 0) next[index] = { ...next[index], ...account };
    else next.push(account);
  }
  return next;
}
