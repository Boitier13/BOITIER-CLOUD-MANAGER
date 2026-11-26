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
    if (index < 0) {
      next.push(account);
      continue;
    }
    // Même identifiant, autre fournisseur : on ne remplace pas. C'est le
    // scénario qui a fait osciller l'inventaire entre deux répartitions fausses.
    if (next[index].provider !== account.provider) continue;
    next[index] = { ...next[index], ...account };
  }
  return next;
}

/**
 * Identifiant cohérent avec le fournisseur.
 *
 * Un compte MEGA porte `mega-real-…`, un compte Google `gdrive-real-…`. Quand
 * les deux fournisseurs utilisent la même adresse — cas réel — l'appariement par
 * adresse seule a fait adopter à un compte MEGA l'identifiant d'un compte
 * Google. Les deux se recouvraient alors à chaque synchronisation : l'inventaire
 * restait à treize comptes, mais la répartition basculait sans cesse entre
 * « 9 Google · 4 MEGA » et « 2 Google · 11 MEGA ».
 *
 * Seuls les identifiants **volés** sont corrigés : renommer les autres
 * casserait les références (favoris, transferts, dossier courant).
 */
function identifiantVolé(account: Account): string | null {
  if (account.provider === 'mega' && account.id.startsWith('gdrive-real-') && account.megaId) {
    return `mega-real-${account.megaId}`;
  }
  if (account.provider === 'gdrive' && account.id.startsWith('mega-real-') && account.googleId) {
    return `gdrive-real-${account.googleId}`;
  }
  return null;
}

/**
 * Rétablit des identifiants cohérents et écarte les doublons.
 *
 * Appliqué à la lecture de l'état enregistré : une seule fois suffit à réparer
 * un inventaire abîmé par l'ancien appariement par adresse.
 */
export function normalizeAccounts(accounts: Account[]): Account[] {
  const parId = new Map<string, Account>();
  for (const account of accounts) {
    const corrige = identifiantVolé(account);
    const id = corrige ?? account.id;
    const candidat = id === account.id ? account : { ...account, id };
    const deja = parId.get(id);
    if (!deja) {
      parId.set(id, candidat);
      continue;
    }
    // Même identifiant : on garde celui dont le fournisseur correspond à
    // l'identifiant rétabli.
    if (corrige && deja.id !== corrige) parId.set(id, candidat);
  }
  return [...parId.values()];
}
