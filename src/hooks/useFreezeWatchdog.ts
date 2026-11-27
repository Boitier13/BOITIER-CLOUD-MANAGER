/**
 * Sentinelle de figement.
 *
 * Le défaut signalé — « l'application se fige beaucoup » — ne laissait aucune
 * trace exploitable. Ce module en produit trois, chacune répondant à une
 * question différente :
 *
 *   1. **L'interface s'est-elle bloquée ?** Deux mesures : un minuteur de 500 ms
 *      (blocages longs) et l'observateur de tâches longues de Chromium
 *      (blocages de 250 ms à 1 s, trop courts pour le minuteur mais sensibles
 *      à l'usage).
 *   2. **Ou est-ce le processus principal ?** Un aller-retour minimal (`ping`)
 *      toutes les 2 secondes. Si le retour tarde, c'est la fenêtre qui attend
 *      son processus — l'interface peut peindre et pourtant ne rien accepter.
 *   3. **Où cela se produit-il ?** L'écran courant est joint à chaque ligne.
 *
 * Rien n'est corrigé ici : tout est écrit dans `demarrage.log`.
 */

import { useEffect, useRef } from 'react';
import { lirePhase } from '../lib/trace';

/** Cadence du minuteur : assez fine pour voir un gel d'une seconde. */
const PERIODE_MS = 500;
/** Retard du minuteur à partir duquel on parle de figement. */
const SEUIL_MINUTEUR_MS = 600;
/** Durée d'une tâche longue signalée par Chromium. */
const SEUIL_TACHE_MS = 250;
/** Cadence de l'aller-retour vers le processus principal. */
const PERIODE_PING_MS = 2000;
/** Aller-retour au-delà duquel le processus principal est déclaré lent. */
const SEUIL_PING_MS = 700;

export function useFreezeWatchdog(ecran: string): void {
  // L'écran change souvent ; on ne veut pas recréer les observateurs pour
  // autant. Une référence suffit, et évite d'abîmer les mesures en cours.
  const ecranRef = useRef(ecran);
  ecranRef.current = ecran;

  useEffect(() => {
    const signaler = typeof window === 'undefined' ? undefined : window.boitier?.reportFreeze;
    // Dans un navigateur, aucun journal : inutile de faire tourner quoi que ce soit.
    if (!signaler) return;

    // La phase en cours est citée : « tâche longue · écran files · rendu files »
    // dit où chercher, là où « tâche longue · écran files » laissait deviner.
    const contexte = (origine: string) =>
      `${origine} · écran ${ecranRef.current} · ${lirePhase()}`;
    /**
     * Une fenêtre masquée ou réduite n'est pas une fenêtre figée : Chromium
     * étrangle ses minuteurs à une fois par minute. Le journal se remplissait de
     * « figement 59,5 s » toutes les minutes simplement parce que l'application
     * était derrière une autre fenêtre — et ces fausses alertes masquaient les
     * vrais blocages. On ne mesure donc que ce qui est visible.
     */
    const visible = () => document.visibilityState === 'visible';

    // 1a. Blocages longs : le minuteur reprend en retard, l'écart est le temps perdu.
    // Horloge monotone : `Date.now()` saute quand Windows resynchronise l'heure
    // ou sort de veille, et produisait des « figements » de 59,5 s sans aucun
    // blocage réel.
    let attendu = performance.now() + PERIODE_MS;
    const minuteur = window.setInterval(() => {
      const maintenant = performance.now();
      const retard = maintenant - attendu;
      if (retard > SEUIL_MINUTEUR_MS && visible()) {
        signaler(retard, contexte('interface'));
      }
      // Remise à zéro à chaque battement : au retour de la fenêtre, le premier
      // tour ne compte pas le temps passé en arrière-plan.
      attendu = maintenant + PERIODE_MS;
    }, PERIODE_MS);

    // Au retour, on repart d'une mesure propre : le temps d'arrière-plan a déjà
    // été écarté ci-dessus, et le minuteur peut avoir été étranglé.
    const onVisibility = () => {
      attendu = performance.now() + PERIODE_MS;
    };
    document.addEventListener('visibilitychange', onVisibility);

    // 1b. Blocages courts, ceux qui rendent l'application pâteuse sans jamais
    // laisser une seconde d'arrêt : mesurés par le navigateur lui-même.
    let observateur: PerformanceObserver | null = null;
    try {
      observateur = new PerformanceObserver((liste) => {
        for (const entree of liste.getEntries()) {
          if (entree.duration >= SEUIL_TACHE_MS && visible()) {
            signaler(entree.duration, contexte('tâche longue'));
          }
        }
      });
      observateur.observe({ entryTypes: ['longtask'] });
    } catch {
      observateur = null; // navigateur sans « longtask » : on garde le minuteur
    }

    // 2. Réactivité du processus principal.
    const ping = window.boitier?.ping;
    let vivant = true;
    let boucle: number | undefined;
    const mesurer = async () => {
      if (!ping || !vivant || !visible()) return;
      const depart = performance.now();
      try {
        await ping();
      } catch {
        return;
      }
      const duree = performance.now() - depart;
      if (duree > SEUIL_PING_MS && vivant) signaler(duree, contexte('processus principal'));
    };
    if (ping) boucle = window.setInterval(() => void mesurer(), PERIODE_PING_MS);

    return () => {
      vivant = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(minuteur);
      if (boucle !== undefined) window.clearInterval(boucle);
      observateur?.disconnect();
    };
  }, []);
}
