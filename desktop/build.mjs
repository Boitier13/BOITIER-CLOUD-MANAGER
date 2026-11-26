/**
 * Compilation de la partie bureau (processus principal Electron).
 *
 * Le rendu React reste compilé par Vite : seul le code Node est regroupé ici,
 * dans un unique fichier CommonJS qu'Electron peut charger directement.
 *
 * Le point d'entrée est `boot.ts`, pas `main.ts` : il ouvre le journal avant de
 * charger le code applicatif, pour qu'un échec de chargement laisse une trace.
 */

import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const outDir = 'desktop/dist';
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: ['desktop/boot.ts'],
  outfile: `${outDir}/main.cjs`,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  // Electron est fourni par le binaire, jamais empaqueté.
  external: ['electron'],
  logLevel: 'info',
});

await copyFile('desktop/preload.cjs', `${outDir}/preload.cjs`);
console.log('desktop: build terminé');
