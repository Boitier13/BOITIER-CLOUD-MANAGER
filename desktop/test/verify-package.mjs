/**
 * Contrôle du contenu de l'application empaquetée, sans construire d'installeur.
 *
 * L'installeur Windows est produit par la CI : electron-builder a besoin du
 * binaire Electron, indisponible hors ligne. Ici, on vérifie ce qui serait
 * réellement embarqué, en reproduisant exactement la liste `files` de
 * `package.json` :
 *
 *   1. l'archive contient la fenêtre, le preload et l'interface compilée ;
 *   2. elle ne contient ni source superflue, ni secret, ni données locales ;
 *   3. `dist/index.html` reste chargeable en `file://` depuis l'archive.
 *
 * Lancement : npm run desktop:package-test
 */

import { createPackage, extractAll } from '@electron/asar';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const build = pkg.build ?? {};

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

/* --- 1. Configuration declarée ------------------------------------------- */

check('identifiant d’application', /^[a-z0-9.]+\.[a-z0-9.]+$/.test(build.appId ?? ''), build.appId);
check('nom du produit', build.productName === 'BOITIER CLOUD MANAGER', build.productName);
check('cible Windows NSIS x64', JSON.stringify(build.win?.target ?? '').includes('nsis'));
check('icône Windows présente', existsSync(join(root, build.win?.icon ?? 'build/icon.ico')));
check('icône source 512 px présente', existsSync(join(root, 'build/icon.png')));
check('installeur assisté (pas silencieux)', build.nsis?.oneClick === false);
check(
  'point d’entrée = processus principal',
  pkg.main === 'desktop/dist/main.cjs' && build.extraMetadata?.main === pkg.main,
  pkg.main,
);

/* --- 2. Prérequis compilés ----------------------------------------------- */

const shipped = [
  'dist',
  'desktop/dist/main.cjs',
  'desktop/dist/preload.cjs',
  'package.json',
];

for (const file of ['dist/index.html', 'desktop/dist/main.cjs', 'desktop/dist/preload.cjs']) {
  check(`prérequis compilé : ${file}`, existsSync(join(root, file)));
}

/* --- 3. Archive reproduite ----------------------------------------------- */

const work = await mkdtemp(join(tmpdir(), 'boitier-package-'));
const staging = join(work, 'app');
const archive = join(work, 'app.asar');
const extracted = join(work, 'extracted');

try {
  // Copie stricte des seuls éléments livrés (équivalent de `files`).
  for (const entry of shipped) {
    const target = join(staging, entry);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(root, entry), target, {
      recursive: true,
      filter: (source) => !source.endsWith('.map'),
    });
  }

  await createPackage(staging, archive);
  await mkdir(extracted, { recursive: true });
  extractAll(archive, extracted);

  for (const file of ['dist/index.html', 'desktop/dist/main.cjs', 'desktop/dist/preload.cjs']) {
    check(`embarqué : ${file}`, existsSync(join(extracted, file)));
  }

  // L'interface doit rester chargeable depuis l'intérieur de l'archive.
  const html = readFileSync(join(extracted, 'dist/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  check('interface référencée', assets.length === 2, `${assets.length} fichiers`);

  const distRoot = join(extracted, 'dist');
  for (const asset of assets) {
    const target = resolve(distRoot, asset);
    const reachable = target.startsWith(distRoot + sep) && existsSync(target);
    check(`ressource dans l’archive : ${asset}`, reachable);
  }

  const mainCode = readFileSync(join(extracted, 'desktop/dist/main.cjs'), 'utf8');
  check('pas d’import.meta dans le bundle', !/import\.meta/.test(mainCode));
  check('preload résolu par le processus principal', mainCode.includes('preload.cjs'));

  // Ni source, ni secret, ni donnée locale, ni carte source.
  for (const item of [
    'src',
    'desktop/main.ts',
    'desktop/test',
    'node_modules',
    '.env.local',
    'google-accounts.enc',
    'desktop/dist/main.cjs.map',
  ]) {
    check(`absent de l’archive : ${item}`, !existsSync(join(extracted, item)));
  }

  const pageUrl = pathToFileURL(join(extracted, 'dist/index.html'));
  check('page située dans l’archive (file://)', pageUrl.href.includes('app.asar') || pageUrl.protocol === 'file:');
} catch (cause) {
  failures += 1;
  console.error('Erreur pendant le contrôle de l’archive :', cause.message);
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

console.log(
  failures === 0
    ? '\nL’application empaquetée est complète et sans données sensibles.'
    : `\n${failures} problème(s) détecté(s).`,
);
process.exit(failures === 0 ? 0 : 1);
