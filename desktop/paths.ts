/**
 * Emplacements de l'application à l'exécution.
 *
 * Module volontairement pur : il ne dépend pas d'Electron et peut donc être
 * vérifié automatiquement, y compris dans le bundle empaqueté.
 *
 * Les deux dispositions coïncident volontairement : l'installeur conserve
 * l'arborescence du dépôt dans `app.asar`.
 *
 *   développement  : <repo>/desktop/dist/main.cjs            → <repo>/dist/
 *   application    : app.asar/desktop/dist/main.cjs          → app.asar/dist/
 *
 * `BOITIER_RENDERER_DIR` force le dossier de l'interface (tests, dépannage).
 */

import { join, resolve } from 'node:path';

export function resolveRendererDir(baseDir: string): string {
  const forced = process.env.BOITIER_RENDERER_DIR;
  if (forced) return resolve(forced);
  return resolve(baseDir, '..', '..', 'dist');
}

export function resolvePreload(baseDir: string): string {
  return join(baseDir, 'preload.cjs');
}

/** Dossier de travail des données (coffre chiffré, caches). */
export function resolveDataDir(appData: string): string {
  return join(appData, 'BOITIER CLOUD MANAGER');
}
