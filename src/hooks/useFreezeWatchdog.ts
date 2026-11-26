/**
 * Sentinelle de figement.
 *
 * Le défaut signalé — « l'application se fige beaucoup » — ne laissait aucune
 * trace : impossible de dire si le blocage a duré 300 ms ou 4 s, ni s'il
 * touchait l'interface seule ou tout le processus. Un minuteur de 500 ms suffit
 * à le mesurer : quand un blocage survient, le minuteur reprend tres en retard,
 * et l'écart est exactement le temps perdu.
 *
 * Purement diagnostique : rien n'est corrigé ici, tout est écrit dans
 * `demarrage.log`.
 */

import { useEffect } from 'react';

/** Cadence de la sentinelle : assez fine pour voir un gel d'une seconde. */
const PERIODE_MS = 500;

/**
 * Retard à partir duquel on parle de figement. En dessous, c'est le bruit
 * normal d'un rendu un peu lourd — inutile d'alarmer.
 */
const SEUIL_MS = 1200;

export function useFreezeWatchdog(): void {
  useEffect(() => {
    const signaler = typeof window === 'undefined' ? undefined : window.boitier?.reportFreeze;
    // Dans un navigateur, aucun journal : inutile de faire tourner un minuteur.
    if (!signaler) return;

    let attendu = Date.now() + PERIODE_MS;
    const timer = window.setInterval(() => {
      const maintenant = Date.now();
      const retard = maintenant - attendu;
      if (retard > SEUIL_MS) signaler(retard);
      attendu = maintenant + PERIODE_MS;
    }, PERIODE_MS);
    return () => window.clearInterval(timer);
  }, []);
}
