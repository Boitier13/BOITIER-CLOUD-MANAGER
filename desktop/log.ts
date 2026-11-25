/**
 * Journal de démarrage.
 *
 * Écrit dans le dossier de données de l'application, à côté du coffre chiffré :
 * version démarrée, mode (installé / développement), et résultat du chargement
 * de l'interface. Une seule ligne d'historique par lancement, sans aucune
 * donnée personnelle.
 *
 * Raison d'être : un défaut au premier lancement après mise à jour — fenêtre
 * affichée mais interface inerte — est indiagnostiquable sans trace. Ce journal
 * rend la cause lisible sans instrumenter l'application à la main.
 *
 * Le fichier reste volontairement petit : rotation à 64 Ko.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 64 * 1024;

let filePath: string | null = null;

/** Prépare le journal et renvoie son chemin (ou `null` si le disque refuse). */
export function initLog(dataDir: string): string | null {
  try {
    mkdirSync(dataDir, { recursive: true });
    const target = join(dataDir, 'demarrage.log');
    try {
      if (statSync(target).size > MAX_BYTES) renameSync(target, `${target}.1`);
    } catch {
      /* fichier absent : première écriture */
    }
    filePath = target;
    return target;
  } catch {
    filePath = null;
    return null;
  }
}

/** Ajoute une ligne horodatée. Ne lève jamais : un journal ne doit rien casser. */
export function log(message: string): void {
  if (!filePath) return;
  const line = `${new Date().toISOString()}  ${message}\n`;
  try {
    appendFileSync(filePath, line, 'utf8');
  } catch {
    /* disque plein ou droits insuffisants : on continue sans journal */
  }
}
