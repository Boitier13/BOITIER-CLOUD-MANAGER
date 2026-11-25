/**
 * Compilation de la partie bureau (processus principal Electron).
 *
 * Le rendu React reste compilé par Vite : seul le code Node est regroupé ici,
 * dans un unique fichier CommonJS qu'Electron peut charger directement.
 */

import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

const outDir = 'desktop/dist';
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: ['desktop/main.ts'],
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
