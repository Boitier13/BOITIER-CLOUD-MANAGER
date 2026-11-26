import { getBridge } from './bridge';

/**
 * Traces de durée, vers le journal du processus principal.
 *
 * Les figements signalés (0,8 s sur l'accueil, 2,5 s sur les fichiers) ne
 * laissaient aucune indication sur *ce qui* bloque : la sentinelle dit combien
 * de temps est perdu, pas où. Ces mesures comblent ce trou, sans jamais peser
 * sur l'exécution : quelques lignes au plus, et seulement au-delà du seuil.
 */

/** Durée à partir de laquelle une phase mérite une ligne dans le journal. */
const SEUIL_MS = 120;
/** Plafond : un journal saturé serait illisible et coûteux à écrire. */
const MAX_LIGNES = 40;

let ecrites = 0;

function ecrire(message: string): void {
  if (ecrites >= MAX_LIGNES) return;
  const note = getBridge()?.note;
  if (typeof note !== 'function') return;
  ecrites += 1;
  try {
    note(message);
  } catch {
    /* journal absent : la mesure est simplement perdue */
  }
}

/** Note la durée d'une phase de calcul, si elle dépasse le seuil. */
export function traceDuree(phase: string, ms: number, detail = ''): void {
  if (ms < SEUIL_MS) return;
  ecrire(`durée : ${phase} ${Math.round(ms)} ms${detail ? ` — ${detail}` : ''}`);
}

/** Note la durée d'un rendu React (mesurée par `<Profiler>`). */
export function traceRendu(id: string, phase: string, actualDuration: number): void {
  if (actualDuration < SEUIL_MS) return;
  ecrire(`rendu ${id} (${phase}) : ${Math.round(actualDuration)} ms`);
}

/** Chronomètre une fonction synchrone et note sa durée. */
export function chrono<T>(phase: string, travail: () => T): T {
  const depart = performance.now();
  try {
    return travail();
  } finally {
    traceDuree(phase, performance.now() - depart);
  }
}
