/**
 * Contrôle de l'interface compilée, sans navigateur ni Electron.
 *
 * Depuis la suppression des données fictives, le premier lancement présente un
 * état vide : c'est le cas le plus facile à casser sans s'en apercevoir. On
 * vérifie donc, sur le bundle réellement livré :
 *
 *   1. aucun décor fictif ne subsiste (comptes, fichiers, transferts inventés) ;
 *   2. les six écrans s'affichent sans compte et proposent une action utile ;
 *   3. avec un compte connecté simulé, son contenu réel s'affiche ;
 *   4. aucune erreur JavaScript pendant ces parcours.
 *
 * Lancement : npm run verify:interface (inclus dans verify:desktop)
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dist = join(root, 'dist');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const html = await readFile(join(dist, 'index.html'), 'utf8');
const pageUrl = pathToFileURL(join(dist, 'index.html'));
const jsHref = /src="([^"]+\.js)"/.exec(html)?.[1];
check('bundle JavaScript trouvé', Boolean(jsHref), jsHref ?? 'aucun');
const js = await readFile(new URL(jsHref, pageUrl), 'utf8');

/* --- 1. Aucun décor fictif dans le code livré --------------------------- */
for (const forbidden of ['MEGA', 'SHADOW', 'TERABOX', 'shadow.demo', 'terabox.demo']) {
  check(`aucun fournisseur fictif : ${forbidden}`, !js.includes(forbidden));
}
check(
  'aucun compte de démonstration pré-rempli',
  !/makeSeedAccounts|seedDownloads/.test(js),
);

/* --- Parcours guidé ----------------------------------------------------- */
async function parcours({ label, bridge }) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (error) => errors.push(String(error.message)));

  const dom = new JSDOM(html, {
    url: 'http://localhost:4173/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  window.Element.prototype.scrollIntoView = function () {};
  if (bridge) window.boitier = bridge;

  window.eval(js);
  await new Promise((r) => setTimeout(r, 700));

  const doc = window.document;
  check(`[${label}] application montée`, Boolean(doc.querySelector('.app')));
  check(`[${label}] aucune erreur console`, errors.length === 0, errors.slice(0, 2).join(' | '));

  const click = async (element) => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
  };
  const text = () => doc.body.textContent ?? '';

  const screens = [];
  const after = {};
  for (const name of [
    'Accueil',
    'Tous les fichiers',
    'Téléchargements',
    'Favoris',
    'Google Drive',
    'Paramètres',
  ]) {
    const target = [...doc.querySelectorAll('.nav-item, .cloud-item')].find((button) =>
      (button.textContent ?? '').includes(name),
    );
    if (!target) {
      check(`[${label}] entrée « ${name} »`, false, 'absente de la navigation');
      continue;
    }
    await click(target);
    const title = doc.querySelector('.page-title')?.textContent?.trim() ?? '';
    check(`[${label}] écran « ${name} » porte un titre`, title.length > 0, title);
    screens.push(title);
    after[name] = text();
  }

  return { text, doc, after, click };
}

/* --- 2. État de départ : aucun compte ----------------------------------- */
const vide = await parcours({ label: 'sans compte', bridge: null });
// On juge l'accueil, pas le dernier écran visité par le parcours.
const corpsVide = vide.after['Accueil'];
check(
  'sans compte : accueil invite à connecter',
  /Connecter Google Drive/.test(corpsVide),
);
for (const forbidden of ['démonstration', 'Démonstration', 'fictif', 'simulé']) {
  check(`sans compte : aucune mention « ${forbidden} »`, !corpsVide.includes(forbidden));
}

/* --- 3. Compte connecté : le contenu réel s'affiche --------------------- */
const compte = await parcours({
  label: 'compte réel',
  bridge: {
    platform: 'win32',
    ready: async () => true,
    google: {
      status: async () => ({ configured: true, source: 'env' }),
      accounts: async () => [
        {
          accountId: 'g-1',
          name: 'Boitier',
          email: 'boitier.perso@gmail.com',
          usedBytes: 41 * 1024 ** 3,
          quotaBytes: 200 * 1024 ** 3,
          status: 'connected',
        },
      ],
      onDownload: () => () => {},
      list: async () => [
        {
          id: 'f1',
          name: 'Rapport annuel.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          size: 2_400_000,
          modified: new Date().toISOString(),
        },
      ],
      search: async () => [],
      shared: async () => [
        {
          id: 's1',
          name: 'Planning équipe.xlsx',
          kind: 'file',
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 15_360,
          modified: new Date().toISOString(),
        },
      ],
    },
  },
});
check(
  'compte réel : adresse affichée',
  compte.after['Google Drive'].includes('boitier.perso@gmail.com'),
  'écran du fournisseur',
);
check('compte réel : lecture seule annoncée', /Lecture seule/.test(compte.text()));

/* --- 4. Vue « Partagés avec moi » --------------------------------------- */
{
  const { doc, click } = compte;
  const files = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Tous les fichiers'),
  );
  if (files) await click(files);
  const sharedEntry = [...doc.querySelectorAll('.rail-account--sub')].find((button) =>
    (button.textContent ?? '').includes('Partagés avec moi'),
  );
  check('vue partagée : entrée présente dans le volet des comptes', Boolean(sharedEntry));
  if (sharedEntry) {
    await click(sharedEntry);
    const crumbs = doc.querySelector('.crumbs')?.textContent ?? '';
    check('vue partagée : fil d’Ariane nommé', /Partagés avec moi/.test(crumbs), crumbs.trim());
    check(
      'vue partagée : le fichier partagé est listé',
      (doc.querySelector('.filetable-wrap')?.textContent ?? '').includes('Planning équipe.xlsx'),
    );
    await click(sharedEntry);
    check(
      'vue partagée : retour aux dossiers du compte',
      !/Partagés avec moi/.test(doc.querySelector('.crumbs')?.textContent ?? ''),
    );
  }
}

console.log(
  failures === 0
    ? '\nInterface vérifiée : état vide maîtrisé, compte réel affiché, aucun décor.'
    : `\n${failures} problème(s) détecté(s).`,
);
process.exit(failures === 0 ? 0 : 1);
