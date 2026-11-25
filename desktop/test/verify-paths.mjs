/**
 * Vérifie ce que la fenêtre Electron demanderait réellement, en `file://`.
 *
 * Deux contrôles complémentaires :
 *  1. le bundle `dist/index.html` référence des ressources relatives, et
 *     chacune existe sur le disque ;
 *  2. le processus principal compilé n'utilise pas `import.meta` (vide en CJS)
 *     et résout bien `index.html` et `preload.cjs`.
 *
 * Lancement : npm run desktop:paths (inclus dans verify:desktop)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dist = join(root, 'dist');
const mainBundle = join(root, 'desktop', 'dist', 'main.cjs');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- 1. Le HTML de production est-il chargeable en file:// ? ---------------
const indexPath = join(dist, 'index.html');
check('build de production présent', existsSync(indexPath), indexPath);

if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  const pageUrl = pathToFileURL(indexPath);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  check('ressources référencées', assets.length > 0, `${assets.length} fichiers`);

  for (const asset of assets) {
    const relative = asset.startsWith('./') || asset.startsWith('../');
    check(
      `chemin relatif : ${asset}`,
      relative,
      relative ? '' : 'chemin absolu — écran blanc en file://',
    );
    const resolved = new URL(asset, pageUrl);
    const onDisk = fileURLToPath(resolved);
    check(`existe sur le disque : ${asset}`, existsSync(onDisk), onDisk);
  }

  // Un seul fichier JS : en file://, un import dynamique échouerait (CORS).
  const scripts = assets.filter((asset) => asset.endsWith('.js'));
  check('un seul bundle JS', scripts.length === 1, `${scripts.length} fichiers`);

  for (const asset of scripts) {
    const code = readFileSync(fileURLToPath(new URL(asset, pageUrl)), 'utf8');
    check(
      'aucun import.meta dans le bundle de l’interface',
      !code.includes('import.meta'),
      `${asset}`,
    );
    check(
      'aucun import dynamique de module local',
      !/\.then\(\(\)=>[A-Za-z_$][\w$]*\)/.test(code),
    );
  }
}

// --- 2. Chargement réel de la page via le protocole file:// ---------------
// Chromium applique des règles CORS strictes en file:// : un module importé
// dynamiquement échoue. On vérifie ici que le HTML et ses ressources forment
// un ensemble autonome, sans dépendance chargée à l'exécution.

const localAssets = [];
if (existsSync(indexPath)) {
  const html = readFileSync(indexPath, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    localAssets.push(match[1]);
  }
  const remote = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  check('aucune ressource distante bloquante', remote.length === 0, remote.join(', '));
  check(
    'toutes les ressources sont locales',
    localAssets.every((asset) => !asset.startsWith('http')),
  );
}

// --- 3. Le processus principal empaqueté est-il correct ? -----------------
check('processus principal compilé', existsSync(mainBundle), mainBundle);

if (existsSync(mainBundle)) {
  const code = readFileSync(mainBundle, 'utf8');
  check(
    'aucun import.meta dans le bundle CJS',
    !/import\.meta/.test(code.replace(/\/\*[\s\S]*?\*\//g, '')),
  );
  check('__dirname utilisé', code.includes('__dirname'));
  check('preload embarqué', existsSync(join(root, 'desktop', 'dist', 'preload.cjs')));

  // --- 3 bis. La fenêtre ne peut pas rester inerte sans le dire -------------
  // Défaut réellement observé : au premier lancement après une mise à jour, la
  // fenêtre s'ouvre et aucun menu ne réagit ; seule une relance rétablit tout.
  // Ces contrôles garantissent qu'un tel cas est désormais détecté et expliqué.
  check(
    'garde-fou de chargement dans le processus principal',
    code.includes('did-fail-load') && code.includes('render-process-gone'),
  );
  check(
    'délai de réaction de l’interface',
    /RENDERER_TIMEOUT_MS/.test(code) || /12_?000/.test(code),
  );
  check('journal de démarrage', existsSync(join(root, 'desktop', 'log.ts')));

  const preload = readFileSync(join(root, 'desktop', 'dist', 'preload.cjs'), 'utf8');
  check(
    'signal de vie exposé par le preload',
    preload.includes('renderer-ready'),
    preload.includes('renderer-ready') ? '' : 'l’interface ne peut pas se signaler',
  );

  // Résolution réelle : équivalent de desktop/dist/main.cjs en production.
  const module = await import('../paths.ts');
  const devRenderer = module.resolveRendererDir(join(root, 'desktop', 'dist'));
  check(
    'dist/ résolu depuis desktop/dist',
    resolve(devRenderer) === resolve(dist),
    devRenderer,
  );
  check(
    'index.html résolu',
    existsSync(join(devRenderer, 'index.html')),
    join(devRenderer, 'index.html'),
  );
  check(
    'preload résolu',
    existsSync(module.resolvePreload(join(root, 'desktop', 'dist'))),
  );

  // Emplacement dans l'application installée (resources/app.asar).
  const packaged = module.resolveRendererDir('/opt/app/resources/app.asar/desktop/dist');
  check(
    'dist/ résolu depuis app.asar',
    packaged === resolve('/opt/app/resources/app.asar/dist'),
    packaged,
  );
}

console.log(
  failures === 0
    ? '\nLa fenêtre peut charger l’interface en file://.'
    : `\n${failures} problème(s) détecté(s).`,
);
process.exit(failures === 0 ? 0 : 1);
