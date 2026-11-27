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
// MEGA n'est plus un décor : c'est un fournisseur réel, avec sa session et ses
// transferts. Les fournisseurs purement fictifs des versions précédentes, eux,
// ne doivent jamais réapparaître dans le paquet livré.
for (const forbidden of ['TERABOX', 'shadow.demo', 'terabox.demo']) {
  check(`aucun fournisseur fictif : ${forbidden}`, !js.includes(forbidden));
}
check(
  'fournisseur réel : MEGA est proposé',
  js.includes('MEGA') && /Connecter un compte MEGA/.test(js),
  'MEGA absent du paquet',
);
check(
  'aucun compte de démonstration pré-rempli',
  !/makeSeedAccounts|seedDownloads/.test(js),
);

/* --- Parcours guidé ----------------------------------------------------- */
async function parcours({ label, bridge, storage }) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (error) => errors.push(String(error.message)));
  // Diagnostic ponctuel : `BOITIER_DEBUG=1` affiche les erreurs React, qui
  // passent par `console.error` et non par `jsdomError`.
  if (process.env.BOITIER_DEBUG) {
    vc.on('error', (...args) => console.log(`   [${label}] console.error :`, ...args));
  }

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
  // État enregistré par une session précédente (démarrage à froid).
  if (storage) window.localStorage.setItem(storage.key, JSON.stringify(storage.value));

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
    'Récents',
    'Stockage',
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

  return { text, doc, after, click, window };
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
/**
 * Identifiants reçus par le pont. Un compte porte deux identifiants : celui de
 * l'application et celui de Google. Seul le second existe côté processus
 * principal ; l'interface envoyait le premier, ce qui produisait « Compte
 * Google inconnu » sur un vrai compte. Ces appels enregistrés sont la seule
 * façon de le vérifier : le faux pont répond quoi qu'on lui demande.
 */
const listCalls = [];
const pontTrace = (name, result) => async (accountId) => {
  listCalls.push(`${name}:${accountId}`);
  return result;
};

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
      list: pontTrace('list', [
        {
          id: 'f1',
          name: 'Rapport annuel.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          size: 2_400_000,
          modified: new Date().toISOString(),
        },
        {
          id: 'd1',
          name: 'Projets',
          kind: 'folder',
          mimeType: 'application/vnd.google-apps.folder',
          size: 0,
          modified: new Date().toISOString(),
        },
      ]),
      plan: async () => ({
        files: [
          { fileId: 'p1', path: '2026/Devis.pdf', size: 48_211, mimeType: 'application/pdf' },
        ],
        folders: ['2026'],
        skipped: ['Compte rendu'],
        truncated: false,
        totalBytes: 48_211,
      }),
      search: async () => [],
      download: async () => {},
      recent: async () => [
        {
          id: 'r1',
          name: 'Rapport final.pdf',
          kind: 'file',
          mimeType: 'application/pdf',
          size: 2_400_000,
          modified: new Date(Date.now() - 3_600_000).toISOString(),
        },
        {
          id: 'r-old',
          name: 'Vieux dossier',
          kind: 'folder',
          mimeType: 'application/vnd.google-apps.folder',
          size: 0,
          modified: new Date('2026-01-05T09:00:00.000Z').toISOString(),
        },
      ],
      storage: async () => ({
        usedBytes: 41 * 1024 ** 3,
        quotaBytes: 200 * 1024 ** 3,
        emailBytes: null,
        partial: false,
        categories: [
          { id: 'document', bytes: 12 * 1024 ** 3, count: 4213, partial: false },
          { id: 'video', bytes: 6 * 1024 ** 3, count: 37, partial: false },
        ],
      }),
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
  await new Promise((resolve) => setTimeout(resolve, 250));

  const table = doc.querySelector('.filetable-wrap')?.textContent ?? '';
  check(
    'explorateur : les dossiers réels du compte s’affichent',
    /Rapport annuel\.pdf/.test(table) && /Projets/.test(table),
    table.slice(0, 60).trim() || 'file vide',
  );
  check(
    'explorateur : le pont reçoit l’identifiant Google, jamais l’identifiant interne',
    listCalls.length > 0 && listCalls.every((call) => call === 'list:g-1'),
    listCalls.join(', ') || 'aucun appel',
  );

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

/* --- 5. Téléchargement d'un dossier entier ------------------------------ */
{
  const { doc, click } = compte;
  const files = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Tous les fichiers'),
  );
  if (files) await click(files);
  const folderButton = doc.querySelector('[aria-label^="Télécharger le dossier"]');
  check('dossier : commande de téléchargement complet présente', Boolean(folderButton));
  if (folderButton) {
    await click(folderButton);
    await new Promise((r) => setTimeout(r, 250));
    const dialog = doc.querySelector('.modal')?.textContent ?? '';
    check('dossier : résumé annoncé avant tout transfert', /1 fichier/.test(dialog), dialog.trim());
    check('dossier : destination affichée', /Destination/.test(dialog));
    check(
      'dossier : document Google natif annoncé',
      /Google natif/.test(dialog),
      'compté, pas téléchargé',
    );
    const confirm = [...doc.querySelectorAll('.modal__foot .btn')].find((button) =>
      (button.textContent ?? '').trim() === 'Télécharger',
    );
    check('dossier : bouton de confirmation présent', Boolean(confirm));
    if (confirm) {
      await click(confirm);
      check('dossier : dialogue refermé après lancement', !doc.querySelector('.modal'));
      const downloads = [...doc.querySelectorAll('.nav-item')].find((button) =>
        (button.textContent ?? '').includes('Téléchargements'),
      );
      if (downloads) await click(downloads);
      const queue = [...doc.querySelectorAll('.download-row__name')].map((row) =>
        row.textContent ?? '',
      );
      check(
        'dossier : chaque fichier entre dans la file avec son chemin',
        queue.includes('2026/Devis.pdf'),
        queue.join(', ') || 'file vide',
      );
    }
  }
}

/* --- 6. Écran Stockage : ce qui est mesuré est distingué du reste ------- */
{
  const { doc, click } = compte;
  const storage = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Stockage'),
  );
  if (storage) await click(storage);
  const body = doc.querySelector('.page')?.textContent ?? '';
  check('stockage : quota affiché', /41,0 Go/.test(body) && /200 Go/.test(body), body.slice(0, 80));
  check('stockage : répartition par type présente', /Documents/.test(body) && /Vidéos/.test(body));
  check(
    'stockage : le reste non détaillé est annoncé',
    /non détaillé/.test(body),
    'pas de total inventé',
  );
}

/* --- 7. Écran Récents : la limite de l'API est dite, pas masquée -------- */
{
  const { doc, click } = compte;
  const recent = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Récents'),
  );
  if (recent) await click(recent);
  const body = doc.querySelector('.page')?.textContent ?? '';
  check('récents : fichier modifié récemment affiché', /Rapport final\.pdf/.test(body));
  check(
    'récents : la limite de l’API est écrite à l’écran',
    /modification/.test(body) && /ne transmet pas la date d’ouverture/.test(body),
    'pas d’historique inventé',
  );
  check(
    'récents : un fichier hors fenêtre est écarté',
    !/Vieux dossier/.test(body),
    'filtre de période appliqué',
  );
}

/* --- 8bis. Dix comptes : le volet reste utilisable --------------------- */
{
  const emails = [
    'boitierecup@gmail.com',
    'boitierfirst7@gmail.com',
    'boitierfirst8@gmail.com',
    'boitierfirst82@gmail.com',
    'saturninyoukpo8@gmail.com',
    'saturninyoukpo13@gmail.com',
    'saturninyoukpo82@gmail.com',
    'firstboitier1@gmail.com',
    'firstboitier2@gmail.com',
    'firstboitier3@gmail.com',
  ];
  const dix = await parcours({
    label: 'dix comptes',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () =>
          emails.map((email, index) => ({
            accountId: `g-${index}`,
            name: `Drive ${index + 1}`,
            email,
            usedBytes: 1 * 1024 ** 3,
            quotaBytes: 15 * 1024 ** 3,
            status: 'connected',
          })),
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });
  const files = [...dix.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Tous les fichiers'),
  );
  if (files) await dix.click(files);

  const railInput = dix.doc.querySelector('.rail-search__input');
  check('dix comptes : un filtre apparaît dans le volet', Boolean(railInput));

  const marks = [...dix.doc.querySelectorAll('.rail-mark')].map(
    (mark) => mark.getAttribute('style') ?? '',
  );
  check(
    'dix comptes : chaque compte porte une marque de couleur',
    marks.length >= 10 && new Set(marks).size >= 3,
    `${marks.length} marques, ${new Set(marks).size} teintes`,
  );

  const names = [...dix.doc.querySelectorAll('.rail-account__name')].map(
    (node) => node.textContent ?? '',
  );
  check(
    'dix comptes : le nom affiché est l’adresse, pas un libellé répétitif',
    names.includes('boitierfirst82') && names.includes('saturninyoukpo13'),
    names.slice(0, 3).join(', '),
  );
}

/* --- 8. Comptes Google : la variante d'adresse est signalée ------------- */
{
  // Un second compte dont l'adresse est une variante `+` de la première : la
  // liste doit le montrer, pas le masquer, et l'écran doit l'expliquer.
  const variante = await parcours({
    label: 'compte variante',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'firstboitier1@gmail.com',
            usedBytes: 1 * 1024 ** 3,
            quotaBytes: 15 * 1024 ** 3,
            status: 'connected',
          },
          {
            accountId: 'g-2',
            name: 'Boitier 2',
            email: 'firstboitier1+2@gmail.com',
            usedBytes: 2 * 1024 ** 3,
            quotaBytes: 15 * 1024 ** 3,
            status: 'connected',
          },
        ],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });
  const drive = [...variante.doc.querySelectorAll('.cloud-item')].find((button) =>
    (button.textContent ?? '').includes('Google Drive'),
  );
  if (drive) await variante.click(drive);
  const body = variante.doc.querySelector('.page')?.textContent ?? '';
  check(
    'comptes : la variante d’adresse est expliquée à l’écran',
    /variante d’adresse Gmail/.test(body) && /même boîte/.test(body),
    'pas de doublon silencieux',
  );
}

/* --- 9. Un seul compte : les accords restent au singulier --------------- */
/* --- 10. Rafraîchir le quota change vraiment le chiffre affiché --------- */
{
  const quota = { usedBytes: 6 * 1024 ** 2, quotaBytes: 15 * 1024 ** 3 };
  let refreshed = false;
  const apres = await parcours({
    label: 'un compte rafraîchi',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: quota.usedBytes,
            quotaBytes: quota.quotaBytes,
            status: 'connected',
          },
        ],
        // Google renvoie ici le total du compte, pas l'usage de Drive seul.
        refresh: async () => {
          refreshed = true;
          return {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: 4.9 * 1024 ** 3,
            quotaBytes: quota.quotaBytes,
            status: 'connected',
          };
        },
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const accueil = apres.after['Accueil'] ?? '';
  // Les chiffres collent le mot suivant (« 1 compte1 fournisseur ») : `\b`
  // échouerait entre « r » et « 6 ». On regarde donc l'absence de « s ».
  check(
    'accords : un seul compte s’écrit au singulier',
    /1 compte(?!s)/.test(accueil) && !/1 comptes/.test(accueil),
    accueil.match(/1 comptes?/)?.[0] ?? 'introuvable',
  );
  check(
    'accords : un seul fournisseur s’écrit au singulier',
    /1 fournisseur(?!s)/.test(accueil) && !/1 fournisseurs/.test(accueil),
    accueil.match(/1 fournisseurs?/)?.[0] ?? 'introuvable',
  );
  check(
    'accords : un seul compte actif s’écrit au singulier',
    /1 actif(?!s)/.test(accueil) && !/1 actifs/.test(accueil),
    accueil.match(/1 actifs?/)?.[0] ?? 'introuvable',
  );

  const drive = apres.after['Google Drive'] ?? '';
  check(
    'accords : la carte du fournisseur reste au singulier',
    !/1 comptes/.test(drive) && !/1 connectés/.test(drive),
    drive.match(/1 compte[^·]*·[^\n]{0,14}/)?.[0]?.trim() ?? 'introuvable',
  );

  // Le parcours se termine sur « Paramètres » : il faut revenir à l'écran du
  // fournisseur pour atteindre le bouton de rafraîchissement.
  const driveNav = [...apres.doc.querySelectorAll('.nav-item, .cloud-item')].find((button) =>
    (button.textContent ?? '').includes('Google Drive'),
  );
  if (driveNav) await apres.click(driveNav);

  const refreshButton = [...apres.doc.querySelectorAll('.icon-btn')].find((button) =>
    (button.getAttribute('title') ?? '').includes('Rafraîchir le quota'),
  );
  check('quota : bouton de rafraîchissement présent', Boolean(refreshButton));
  if (refreshButton) {
    await apres.click(refreshButton);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const page = apres.doc.querySelector('.page')?.textContent ?? '';
    check(
      'quota : le rafraîchissement met à jour le chiffre affiché',
      refreshed && /4,9 Go/.test(page) && !/6,0 Mo/.test(page),
      page.match(/[\d,]+\s*(?:Go|Mo)\s*sur\s*[\d,]+\s*Go/)?.[0] ?? 'chiffre inchangé',
    );
  }
}

/* --- 11. Un transfert refusé doit s'afficher comme un échec -------------- */
{
  const requetes = [];
  const echec = await parcours({
    label: 'téléchargement refusé',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: 1 * 1024 ** 3,
            quotaBytes: 15 * 1024 ** 3,
            status: 'connected',
          },
        ],
        onDownload: () => () => {},
        list: async () => [
          {
            id: 'v1',
            name: 'Conference.mp4',
            kind: 'file',
            mimeType: 'video/mp4',
            size: 93 * 1024 ** 2,
            modified: new Date().toISOString(),
          },
        ],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        folder: async () => 'C:\\Users\\Saturnin\\Downloads',
        // Le processus principal refuse : la file doit le dire, pas rester à 0 %.
        download: async (request) => {
          requetes.push(request);
          throw new Error('Espace insuffisant sur le disque.');
        },
      },
    },
  });

  const files = [...echec.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Tous les fichiers'),
  );
  if (files) await echec.click(files);
  const rowButton = echec.doc.querySelector('[aria-label="Télécharger Conference.mp4"]');
  check('échec : commande de téléchargement présente', Boolean(rowButton));
  if (rowButton) {
    await echec.click(rowButton);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const downloads = [...echec.doc.querySelectorAll('.nav-item')].find((button) =>
      (button.textContent ?? '').includes('Téléchargements'),
    );
    if (downloads) await echec.click(downloads);
    const body = echec.doc.querySelector('.page')?.textContent ?? '';
    check(
      'échec : le refus est écrit dans la file',
      /Espace insuffisant sur le disque/.test(body),
      body.slice(0, 80).trim() || 'file vide',
    );
    // Le libellé « En cours » existe aussi comme filtre : on regarde la ligne
    // elle-même, pas la page entière.
    const ligne = echec.doc.querySelector('.download-row')?.textContent ?? '';
    const dest = echec.doc.querySelector('.download-row__dest')?.textContent ?? '';
    // Une vidéo doit être rangée dans « Google Drive\Videos » : le chemin
    // affiché doit donc être celui-là, pas le simple dossier de base.
    check(
      'destination : le chemin réel du dossier apparaît devant la barre',
      dest.trim() === 'C:\\Users\\Saturnin\\Downloads\\Google Drive\\Videos',
      dest.trim() || 'aucun chemin',
    );
    check(
      'destination : le rangement par cloud et par type est demandé au pont',
      requetes[0]?.subPath === 'Google Drive/Videos',
      String(requetes[0]?.subPath),
    );
    check(
      'destination : l’en-tête nomme le dossier réel, pas « dossier système »',
      (echec.doc.querySelector('.badge--path')?.textContent ?? '').includes(
        'C:\\Users\\Saturnin\\Downloads',
      ),
      (echec.doc.querySelector('.badge--path')?.textContent ?? '').slice(0, 60) || 'absent',
    );
    check(
      'échec : le transfert n’est pas présenté comme en cours',
      /Échec/.test(ligne) && !/En cours/.test(ligne),
      ligne.slice(0, 70).trim() || 'aucune ligne',
    );
  }
}

/* --- 11bis. Une ligne « en cours » sans transfert ne doit pas mentir ------ */
{
  let relance = 0;
  const fantome = await parcours({
    label: 'transfert fantôme',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [
          {
            id: 'g-1',
            googleId: 'g-1',
            source: 'google',
            provider: 'gdrive',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            address: 'boitierecup@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            favorite: false,
            connectedAt: '2026-11-01T10:00:00.000Z',
          },
        ],
        favorites: [],
        downloads: [
          {
            id: 'vieux',
            name: 'Conference.mp4',
            type: 'video',
            size: 93 * 1024 ** 2,
            received: 0,
            speed: 0,
            baseSpeed: 0,
            status: 'active',
            provider: 'gdrive',
            accountId: 'g-1',
            accountName: 'Boitier',
            path: [],
            addedAt: '2026-11-25T00:00:00.000Z',
            remoteId: 'v1',
            remoteAccount: 'g-1',
          },
        ],
        // Dossier inventé d'une ancienne version : il doit être oublié.
        settings: { downloadFolder: 'D:\\Médias\\Téléchargements' },
        explorer: { accountId: 'g-1', path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            status: 'connected',
          },
        ],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        download: async () => {
          relance += 1;
        },
      },
    },
  });

  const toDownloads = [...fantome.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Téléchargements'),
  );
  if (toDownloads) await fantome.click(toDownloads);
  const ligne = fantome.doc.querySelector('.download-row')?.textContent ?? '';
  check(
    'fantôme : la ligne héritée est déclarée interrompue, pas « En cours »',
    /Échec/.test(ligne) && !/En cours/.test(ligne),
    ligne.slice(0, 80).trim() || 'aucune ligne',
  );
  const retry = fantome.doc.querySelector('[aria-label="Réessayer le téléchargement"]');
  check('fantôme : un bouton de relance est proposé', Boolean(retry));
  if (retry) {
    await fantome.click(retry);
    check('fantôme : la relance demande un vrai transfert', relance === 1, String(relance));
  }
}

/* --- 11ter. Le réglage du dossier est lié au dossier réel ------------------ */
{
  const cheminSysteme = 'C:\\Users\\Saturnin\\Downloads';
  const reglages = await parcours({
    label: 'dossier de destination',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        folder: async () => cheminSysteme,
        chooseFolder: async () => 'D:\\Vidéos\\Cloud',
      },
    },
  });

  const toSettings = [...reglages.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (toSettings) await reglages.click(toSettings);

  const chip = () => reglages.doc.querySelector('.path-chip')?.textContent?.trim() ?? '';
  check(
    'réglages : le dossier système réel est affiché, pas un libellé',
    chip() === cheminSysteme,
    chip() || 'vide',
  );

  const choose = [...reglages.doc.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes('Choisir…'),
  );
  if (choose) await reglages.click(choose);
  check(
    'réglages : le dossier choisi devient la destination',
    chip() === 'D:\\Vidéos\\Cloud',
    chip() || 'vide',
  );

  const retour = [...reglages.doc.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Système',
  );
  check('réglages : un retour au dossier système est proposé', Boolean(retour));
  if (retour) await reglages.click(retour);
  check(
    'réglages : le retour rend le dossier du système',
    chip() === cheminSysteme,
    chip() || 'vide',
  );
}

/* --- 11quater. Reconnexion d'un compte sans le retirer -------------------- */
{
  let connexions = 0;
  const reconnexion = await parcours({
    label: 'reconnexion',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            status: 'connected',
          },
        ],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        // Le consentement reste en attente : c'est l'état réel pendant que le
        // navigateur est ouvert.
        connect: () => {
          connexions += 1;
          return new Promise(() => {});
        },
      },
    },
  });

  const toClouds = [...reconnexion.doc.querySelectorAll('.nav-item, .cloud-item')].find((button) =>
    (button.textContent ?? '').includes('Google Drive'),
  );
  if (toClouds) await reconnexion.click(toClouds);

  const bouton = reconnexion.doc.querySelector('[aria-label="Reconnecter Boitier"]');
  check('reconnexion : un bouton existe pour un compte déjà connecté', Boolean(bouton));
  if (bouton) {
    await reconnexion.click(bouton);
    const texte = reconnexion.doc.body.textContent ?? '';
    check(
      'reconnexion : le dialogue annonce une mise à jour, pas un doublon',
      /ré-autoriser/i.test(texte) && /mis à jour, pas dupliqué/i.test(texte),
      texte.slice(0, 90).replace(/\s+/g, ' ').trim(),
    );
    check('reconnexion : le consentement Google est demandé', connexions === 1, String(connexions));
  }
}

/* --- 11quinquies. Plus aucune mention d'autorisation à renouveler -------- */
{
  const sansBandeau = await parcours({
    label: 'autorisations renouvelées',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-2',
            name: 'Saturnin Youkpo13',
            email: 'saturninyoukpo13@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            status: 'connected',
            authorizedAt: '2026-11-26T10:00:00.000Z',
          },
        ],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const toClouds = [...sansBandeau.doc.querySelectorAll('.nav-item, .cloud-item')].find(
    (button) => (button.textContent ?? '').includes('Google Drive'),
  );
  if (toClouds) await sansBandeau.click(toClouds);

  const texte = sansBandeau.doc.body.textContent ?? '';
  check(
    'autorisations : plus de bandeau de rappel',
    !/autorisation antérieure/i.test(texte) && !/expirera au bout de sept jours/i.test(texte),
  );
  check(
    'autorisations : plus de mention « à renouveler » sur les lignes',
    !/Autorisation à renouveler/i.test(texte) &&
      sansBandeau.doc.querySelectorAll('.account-row__auth').length === 0,
  );
}

/* --- 11sexies. Taille du texte et densité retirée ------------------------- */
{
  const zooms = [];
  const reglagesTexte = await parcours({
    label: 'taille du texte',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      setZoom: async (factor) => {
        zooms.push(factor);
        return true;
      },
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const toSettings = [...reglagesTexte.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (toSettings) await reglagesTexte.click(toSettings);

  const texte = reglagesTexte.doc.body.textContent ?? '';
  check(
    'réglages : la densité d’affichage a disparu',
    !/Densité d’affichage/i.test(texte),
  );
  check('réglages : la taille du texte est réglable', /Taille du texte/i.test(texte));
  check(
    'réglages : le zoom par défaut dépasse 100 %',
    zooms.length > 0 && zooms[0] > 1,
    zooms.join(', ') || 'aucun appel',
  );

  const bouton130 = [...reglagesTexte.doc.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === '130 %',
  );
  check('réglages : quatre paliers sont proposés', Boolean(bouton130));
  if (bouton130) {
    await reglagesTexte.click(bouton130);
    check(
      'réglages : le palier 130 % est appliqué à la fenêtre',
      zooms.at(-1) === 1.3,
      zooms.join(', '),
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const saved = JSON.parse(
      reglagesTexte.window.localStorage.getItem('boitier-cloud-manager:v1') ?? '{}',
    );
    check(
      'réglages : le palier est conservé pour la prochaine session',
      Math.abs((saved?.settings?.textScale ?? 0) - 1.3) < 0.001,
      String(saved?.settings?.textScale),
    );
  }
}

/* --- 11septies. Neuf comptes : tous visibles, sans coincement -------------- */
{
  const neuf = await parcours({
    label: 'neuf comptes',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier First Recup',
            email: 'boitierecup@gmail.com',
            usedBytes: 1000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-2',
            name: 'Boitier First7',
            email: 'boitierfirst7@gmail.com',
            usedBytes: 2000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-3',
            name: 'Boitier First8',
            email: 'boitierfirst8@gmail.com',
            usedBytes: 3000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-4',
            name: 'Boitier First82',
            email: 'boitierfirst82@gmail.com',
            usedBytes: 4000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-5',
            name: 'Saturnin Youkpo8',
            email: 'saturninyoukpo8@gmail.com',
            usedBytes: 5000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-6',
            name: 'Saturnin Youkpo13',
            email: 'saturninyoukpo13@gmail.com',
            usedBytes: 6000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-7',
            name: 'Boitier First1',
            email: 'firstboitier1@gmail.com',
            usedBytes: 7000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-8',
            name: 'Boitier First2',
            email: 'firstboitier2@gmail.com',
            usedBytes: 8000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          },
          {
            accountId: 'g-9',
            name: 'Boitier First3',
            email: 'firstboitier3@gmail.com',
            usedBytes: 9000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          }
        ],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        storage: async () => ({
          usedBytes: 12 * 1024 ** 3,
          quotaBytes: 16106127360,
          emailBytes: null,
          partial: false,
          categories: [],
        }),
        folder: async () => 'C:\\Users\\BOITIER_FIRST\\Downloads',
      },
    },
  });

  const toStorage = [...neuf.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Stockage'),
  );
  if (toStorage) await neuf.click(toStorage);

  const groupe = neuf.doc.querySelector('.segmented--wrap');
  check('stockage : le groupe de comptes peut passer à la ligne', Boolean(groupe));
  const onglets = groupe ? [...groupe.querySelectorAll('.segmented__item')] : [];
  check('stockage : les neuf comptes sont présents', onglets.length === 9, String(onglets.length));
  const libelles = onglets.map((onglet) => (onglet.textContent ?? '').trim());
  check(
    'stockage : aucun nom n’est coupé',
    libelles.includes('Boitier First3') && libelles.includes('Boitier First2'),
    libelles.join(' | '),
  );
}

/* --- 9. Recherche : tous les comptes, puis un seul ----------------------- */
//
// Demande explicite : chercher dans **tous** les comptes *et* dans un seul.
// Le faux pont répond une liste différente par compte ; le test vérifie que les
// deux portées fonctionnent et que chaque résultat dit de quel compte il vient.
{
  const recherches = [];
  const fichiers = {
    'g-1': [{ id: 'f-1', name: 'Facture EDF.pdf', kind: 'file', mimeType: 'application/pdf', size: 48211, modified: '2026-11-23T16:10:00.000Z' }],
    'g-2': [
      { id: 'f-2', name: 'Facture Orange.pdf', kind: 'file', mimeType: 'application/pdf', size: 30211, modified: '2026-11-22T10:00:00.000Z' },
      { id: 'f-3', name: 'Factures 2025', kind: 'folder', mimeType: 'application/vnd.google-apps.folder', size: 0, modified: '2026-11-21T10:00:00.000Z' },
    ],
    'g-3': [],
  };
  let localisations = 0;

  const recherche = await parcours({
    label: 'recherche',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () =>
          [
            ['g-1', 'Boitier First Recup', 'boitierecup@gmail.com'],
            ['g-2', 'Boitier First7', 'boitierfirst7@gmail.com'],
            ['g-3', 'Boitier First8', 'boitierfirst8@gmail.com'],
          ].map(([accountId, name, email]) => ({
            accountId,
            name,
            email,
            usedBytes: 1000000000,
            quotaBytes: 16106127360,
            status: 'connected',
            authorizedAt: '2026-11-26T09:00:00.000Z',
          })),
        onDownload: () => () => {},
        list: async () => [],
        search: async (accountId, term) => {
          recherches.push(`${accountId}:${term}`);
          return fichiers[accountId] ?? [];
        },
        locate: async () => {
          localisations += 1;
          return [{ id: 'folder-projets', name: 'Projets' }];
        },
        shared: async () => [],
        recent: async () => [],
        storage: async () => ({
          usedBytes: 1,
          quotaBytes: 16106127360,
          emailBytes: null,
          partial: false,
          categories: [],
        }),
        folder: async () => 'C:\\Users\\BOITIER_FIRST\\Downloads',
      },
    },
  });

  const { doc, window } = recherche;
  const versRecherche = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Recherche'),
  );
  check('recherche : l’entrée de menu existe', Boolean(versRecherche));
  if (versRecherche) await recherche.click(versRecherche);
  check(
    'recherche : l’écran porte son titre',
    (doc.querySelector('.page-title')?.textContent ?? '').trim() === 'Chercher partout',
    doc.querySelector('.page-title')?.textContent ?? 'absent',
  );

  // Les deux portées sont visibles avant même de taper.
  const portees = [...doc.querySelectorAll('.segmented__item')].map((item) =>
    (item.textContent ?? '').trim(),
  );
  check('recherche : la portée « Tous les comptes » est proposée', portees.includes('Tous les comptes'), portees.join(' | '));
  check(
    'recherche : chaque compte est aussi une portée',
    portees.includes('Boitier First7') && portees.includes('Boitier First8'),
    portees.join(' | '),
  );

  /** Saisie réelle dans un champ contrôlé par React. */
  const saisir = async (input, valeur, attente = 700) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, valeur);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, attente));
  };

  const champ = doc.querySelector('.search .input');
  check('recherche : un champ de saisie est présent', Boolean(champ));
  if (champ) {
    await saisir(champ, 'facture');
    check(
      'recherche : les comptes sont interrogés à la frappe',
      recherches.some((appel) => appel.endsWith(':facture')),
      recherches.join(' | ') || 'aucun appel',
    );
    const groupes = [...doc.querySelectorAll('.filetable__group-name')].map((node) =>
      node.textContent.trim(),
    );
    check(
      'recherche : les résultats sont regroupés par compte',
      groupes.length === 2 && groupes.includes('Boitier First Recup') && groupes.includes('Boitier First7'),
      groupes.join(' | ') || 'aucun groupe',
    );
    const lignes = [...doc.querySelectorAll('.filetable tbody tr:not(.filetable__group)')];
    check('recherche : chaque fichier trouvé a sa ligne', lignes.length === 3, String(lignes.length));
    check(
      'recherche : un compte sans résultat n’est pas affiché',
      !groupes.includes('Boitier First8'),
    );

    // Portée « un seul compte ».
    const onglet = [...doc.querySelectorAll('.segmented__item')].find(
      (item) => (item.textContent ?? '').trim() === 'Boitier First7',
    );
    if (onglet) await recherche.click(onglet);
    const lignesIsolees = [...doc.querySelectorAll('.filetable tbody tr')];
    check(
      'recherche : la portée « un compte » ne garde que ce compte',
      lignesIsolees.length === 2 &&
        lignesIsolees.every((ligne) => /Facture/.test(ligne.textContent ?? '')),
      `${lignesIsolees.length} ligne(s)`,
    );

    // Ouverture de l'emplacement : le chemin est demandé au pont, puis
    // l'explorateur s'ouvre sur ce dossier.
    const retour = [...doc.querySelectorAll('.segmented__item')].find(
      (item) => (item.textContent ?? '').trim() === 'Tous les comptes',
    );
    if (retour) await recherche.click(retour);
    const premiere = doc.querySelector('.filetable tbody tr:not(.filetable__group)');
    if (premiere) await recherche.click(premiere);
    check(
      'recherche : « ouvrir » demande le chemin réel au pont',
      localisations > 0,
      String(localisations),
    );
    const apresClic = (doc.querySelector('.page-title')?.textContent ?? '').trim();
    check(
      'recherche : l’emplacement trouvé ouvre l’explorateur',
      apresClic === 'Tous les fichiers',
      apresClic || 'titre absent',
    );
  }
}

/* --- 10. Mise à jour prête : l'écran doit le dire et n'installer qu'au clic - */
{
  let installations = 0;
  let verifications = 0;
  let notifier = () => {};
  const etatPret = {
    status: 'ready',
    currentVersion: '0.21.0',
    version: '0.22.0',
    percent: 100,
    checkedAt: '2026-11-26T12:00:00.000Z',
  };

  const maj = await parcours({
    label: 'mise à jour',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      updater: {
        state: async () => etatPret,
        check: async () => {
          verifications += 1;
          return { ...etatPret, status: 'idle' };
        },
        install: async () => {
          installations += 1;
          notifier({ ...etatPret, status: 'installing' });
          return true;
        },
        onChange: (callback) => { notifier = callback; return () => {}; },
      },
      google: {
        status: async () => ({ configured: false, source: 'none' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const { doc } = maj;
  const badge = [...doc.querySelectorAll('.nav-item__count')].find(
    (node) => (node.textContent ?? '').trim() === 'MAJ',
  );
  check('mise à jour : le menu signale une version prête', Boolean(badge));

  const versParametres = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (versParametres) await maj.click(versParametres);
  const corps = doc.body.textContent ?? '';
  check(
    'mise à jour : les paramètres annoncent la version prête',
    /Mises à jour/.test(corps) && /0’|\.22\.0|22\.0/.test(corps) && /prête/i.test(corps),
  );
  check(
    'mise à jour : la version installée est rappelée',
    /0\.21\.0/.test(corps),
    corps.match(/Version [0-9.]+/)?.[0] ?? 'version absente',
  );

  const boutonInstaller = [...doc.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes('Redémarrer et installer'),
  );
  check('mise à jour : le bouton d’installation est proposé', Boolean(boutonInstaller));
  if (boutonInstaller) await maj.click(boutonInstaller);
  check(
    'mise à jour : l’installation n’a lieu qu’après le clic',
    installations === 1,
    `${installations} appel(s)`,
  );
  check(
    'mise à jour : préparation affichée sans possibilité de double clic',
    /Préparation de l’installation/.test(doc.body.textContent ?? '') &&
      ![...doc.querySelectorAll('button')].some((button) => /Redémarrer et installer/.test(button.textContent ?? '')),
  );
  notifier({ ...etatPret, message: 'L’installeur n’a pas pu être lancé. Vous pouvez réessayer.' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  check(
    'mise à jour : erreur lisible et tentative à nouveau possible',
    /L’installeur n’a pas pu être lancé/.test(doc.body.textContent ?? '') &&
      [...doc.querySelectorAll('button')].some((button) => /Redémarrer et installer/.test(button.textContent ?? '')),
  );
  check(
    'mise à jour : aucune vérification déclenchée par l’ouverture de l’écran',
    verifications === 0,
    `${verifications} appel(s)`,
  );
}

/* --- 10bis. Version disponible : rien ne se télécharge tout seul ---------- */
//
// Le téléchargement de l'installeur (près de 100 Mo) partait dès qu'une version
// était trouvée, et son empreinte était vérifiée sur le fil du processus
// principal : « figement 7,6 s · écran settings » pendant qu'on consultait les
// paramètres. Il faut désormais deux clics : télécharger, puis installer.
{
  let telechargements = 0;
  let installations = 0;
  const disponible = {
    status: 'available',
    currentVersion: '0.23.8',
    version: '0.23.9',
    checkedAt: '2026-11-26T12:00:00.000Z',
  };

  const maj = await parcours({
    label: 'mise à jour disponible',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      updater: {
        state: async () => disponible,
        check: async () => disponible,
        download: async () => {
          telechargements += 1;
          return { ...disponible, status: 'ready', percent: 100 };
        },
        install: async () => {
          installations += 1;
          return true;
        },
        onChange: () => () => {},
      },
      google: {
        status: async () => ({ configured: false, source: 'none' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const { doc } = maj;
  const versParametres = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (versParametres) await maj.click(versParametres);
  await new Promise((r) => setTimeout(r, 200));

  check(
    'mise à jour disponible : rien n’est téléchargé sans clic',
    telechargements === 0 && installations === 0,
    `${telechargements} téléchargement(s), ${installations} installation(s)`,
  );
  const boutonTelecharger = [...doc.querySelectorAll('button')].find((button) =>
    /Télécharger 0\.23\.9/.test(button.textContent ?? ''),
  );
  check(
    'mise à jour disponible : le bouton de téléchargement est proposé',
    Boolean(boutonTelecharger),
    [...doc.querySelectorAll('.settings-row__control button')]
      .map((button) => (button.textContent ?? '').trim())
      .join(' | '),
  );
  check(
    'mise à jour disponible : aucune installation possible avant le téléchargement',
    ![...doc.querySelectorAll('button')].some((button) =>
      /Redémarrer et installer/.test(button.textContent ?? ''),
    ),
  );
  if (boutonTelecharger) {
    await maj.click(boutonTelecharger);
    await new Promise((r) => setTimeout(r, 250));
  }
  check(
    'mise à jour disponible : le clic déclenche le téléchargement',
    telechargements === 1,
    `${telechargements} appel(s)`,
  );
  check(
    'mise à jour disponible : une fois prête, l’installation est proposée',
    [...doc.querySelectorAll('button')].some((button) =>
      /Redémarrer et installer/.test(button.textContent ?? ''),
    ),
  );
}

/* --- 11. Navigateur : pas de mise à jour, et on le dit -------------------- */
{
  const web = await parcours({ label: 'navigateur', bridge: null });
  const { doc } = web;
  const versParametres = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (versParametres) await web.click(versParametres);
  const corps = doc.body.textContent ?? '';
  check(
    'navigateur : les mises à jour sont déclarées indisponibles',
    /version installée uniquement/i.test(corps),
    corps.includes('Mises à jour') ? 'mention absente' : 'section absente',
  );
  const bouton = [...doc.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').includes('Rechercher'),
  );
  check('navigateur : le bouton de vérification est inerte', Boolean(bouton) && bouton.disabled);
}

/* --- 12. Téléchargement : la progression doit se voir --------------------- */
//
// Une mise à jour de 90 Mo ne montrait qu'un nombre qui saute. La barre et le
// libellé du bouton rendent l'attente visible — c'est justement l'étape que
// l'utilisateur surveille pendant un essai de mise à jour.
{
  let emettre = null;
  const verifie = new Date().toISOString();
  const etat = {
    status: 'idle',
    currentVersion: '0.22.3',
    checkedAt: verifie,
  };

  const suivi = await parcours({
    label: 'téléchargement',
    bridge: {
      platform: 'win32',
      ready: async () => true,
      updater: {
        state: async () => etat,
        check: async () => etat,
        install: async () => true,
        onChange: (rapport) => {
          emettre = rapport;
          return () => {};
        },
      },
      google: {
        status: async () => ({ configured: false, source: 'none' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const { doc } = suivi;
  const versParametres = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (versParametres) await suivi.click(versParametres);

  check(
    'mise à jour : l’heure de la vérification est affichée',
    /vérifiée à \d{1,2} h \d{2}/.test(doc.body.textContent ?? ''),
    (doc.body.textContent ?? '').match(/À jour[^.]*/)?.[0] ?? 'heure absente',
  );

  if (emettre) {
    emettre({
      status: 'downloading',
      currentVersion: '0.22.3',
      version: '0.23.0',
      percent: 42,
      checkedAt: verifie,
    });
    await suivi.click(doc.body);
  }

  const barre = doc.querySelector('[role="progressbar"]');
  check('mise à jour : une barre de progression apparaît', Boolean(barre));
  check(
    'mise à jour : la barre reflète l’avancement réel',
    barre?.getAttribute('aria-valuenow') === '42',
    barre?.getAttribute('aria-valuenow') ?? 'absente',
  );
  const corps = doc.body.textContent ?? '';
  check('mise à jour : le pourcentage est annoncé en clair', /42 %/.test(corps));
  check(
    'mise à jour : le bouton dit ce qui se passe',
    /Téléchargement…/.test(corps),
    corps.includes('Vérification…') ? 'libellé « Vérification… »' : 'libellé absent',
  );
}

/* --- 13. Accords : « 1 transfert », pas « 1 transferts » ------------------- */
//
// Vu sur une capture : « 0 favoris · 1 transferts ». Le reste de l'application
// accorde (compte/comptes, résultat/résultats) ; cette ligne ne le faisait pas.
{
  const accords = await parcours({
    label: 'pluriels',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [
          {
            id: 'g-1',
            googleId: 'g-1',
            source: 'google',
            provider: 'gdrive',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            address: 'boitierecup@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            favorite: false,
            connectedAt: '2026-11-01T10:00:00.000Z',
          },
        ],
        favorites: [],
        downloads: [
          {
            id: 'fini',
            name: 'Conference.mp4',
            type: 'video',
            size: 93 * 1024 ** 2,
            received: 0,
            speed: 0,
            baseSpeed: 0,
            status: 'active',
            provider: 'gdrive',
            accountId: 'g-1',
            accountName: 'Boitier',
            path: [],
            addedAt: '2026-11-25T00:00:00.000Z',
            remoteId: 'v1',
            remoteAccount: 'g-1',
          },
        ],
        settings: { downloadFolder: 'D:\\Médias\\Téléchargements' },
        explorer: { accountId: 'g-1', path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [
          {
            accountId: 'g-1',
            name: 'Boitier',
            email: 'boitierecup@gmail.com',
            usedBytes: 1,
            quotaBytes: 100,
            status: 'connected',
          },
        ],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
    },
  });

  const { doc } = accords;
  const versParametres = [...doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Paramètres'),
  );
  if (versParametres) await accords.click(versParametres);
  const corps = doc.body.textContent ?? '';

  // Pas de `\b` ici : le libellé est suivi immédiatement du bouton
  // (« 1 transfertRéinitialiser »), donc sans frontière de mot.
  check(
    'accords : « 1 transfert » au singulier',
    /1 transfert(?!s)/.test(corps) && !/1 transferts/.test(corps),
    corps.match(/[0-9] transferts?/)?.[0] ?? 'mention absente',
  );
  const boutonJournal = [...doc.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Ouvrir',
  );
  check(
    'journal : il s’ouvre depuis les paramètres',
    /Journal de démarrage/.test(corps) && Boolean(boutonJournal),
    boutonJournal ? 'bouton présent' : 'aucun bouton',
  );

  check(
    'accords : « 0 favori » au singulier, comme partout ailleurs',
    /0 favori(?!s)/.test(corps) && !/0 favoris/.test(corps),
    corps.match(/[0-9] favoris?/)?.[0] ?? 'mention absente',
  );
}

/* --- 12. Neuf comptes au coffre, deux à l'écran : ils doivent revenir ----- */
//
// Incident réel : le coffre chiffré contenait bien 9 comptes
// (`coffre : 9 compte(s) Google relu(s)`), mais l'écran n'en montrait que 2, et
// la synchronisation du démarrage ne les rétablissait pas. On rejoue donc
// exactement cette situation : un état local appauvri et onze comptes MEGA, en
// face d'un coffre qui en contient neuf.
{
  const neuf = [
    ['g-1', 'boitierecup@gmail.com'],
    ['g-2', 'firstboitier1@gmail.com'],
    ['g-3', 'firstboitier1+2@gmail.com'],
    ['g-4', 'firstboitier1+3@gmail.com'],
    ['g-5', 'firstboitier2@gmail.com'],
    ['g-6', 'firstboitier3@gmail.com'],
    ['g-7', 'boitierfirst7@gmail.com'],
    ['g-8', 'saturninyoukpo8@gmail.com'],
    ['g-9', 'saturninyoukpo13@gmail.com'],
  ].map(([accountId, email]) => ({
    accountId,
    name: email.split('@')[0],
    email,
    usedBytes: 10,
    quotaBytes: 100,
    status: 'connected',
  }));

  const survivants = neuf.slice(0, 2).map((info) => ({
    id: `gdrive-real-${info.accountId}`,
    googleId: info.accountId,
    source: 'google',
    provider: 'gdrive',
    name: info.name,
    email: info.email,
    usedBytes: info.usedBytes,
    quotaBytes: info.quotaBytes,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 7,
    localTree: false,
  }));

  const megas = Array.from({ length: 11 }, (_, index) => ({
    id: `mega-real-m${index}`,
    megaId: `m${index}`,
    source: 'mega',
    provider: 'mega',
    name: `mega${index}`,
    email: `mega${index}@exemple.com`,
    usedBytes: 1,
    quotaBytes: 20,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 11,
    localTree: false,
  }));

  const restauration = await parcours({
    label: 'coffre à 9, écran à 2',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [...survivants, ...megas],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: survivants[0].id, path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => neuf,
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        list: async () => [],
      },
      mega: {
        accounts: async () => [],
        onUpload: () => () => {},
      },
    },
  });

  const pageGoogle = restauration.after['Google Drive'];
  const lignes = (pageGoogle.match(/[a-z0-9.+-]+@(gmail|exemple)\.com/gi) ?? []).length;
  check(
    'comptes : les neuf comptes du coffre reviennent à l’écran',
    neuf.every((info) => pageGoogle.includes(info.email)),
    `${new Set(pageGoogle.match(/[a-z0-9.+-]+@gmail\.com/gi) ?? []).size} adresse(s) Gmail affichée(s)`,
  );
  check(
    'comptes : les comptes MEGA survivent à cette synchronisation'.replace('  ', ' '),
    (restauration.doc.querySelector('.cloud-item--mega, .cloud-item')?.textContent ?? '').length > 0,
  );
  check(
    'comptes : l’écran Google annonce neuf comptes',
    /9 comptes/.test(pageGoogle),
    pageGoogle.match(/\d+ comptes? connectés?/)?.[0] ?? 'compteur absent',
  );
}

/* --- 13. Un premier appel en échec ne doit pas laisser l'écran en l'état -- */
//
// C'est la situation observée chez l'utilisateur : le coffre contient neuf
// comptes, mais la lecture échoue au démarrage. Sans réessai, l'écran reste sur
// l'état enregistré — deux comptes — et rien ne le signale.
{
  const neuf = [
    ['g-1', 'boitierecup@gmail.com'],
    ['g-2', 'firstboitier1@gmail.com'],
    ['g-3', 'firstboitier2@gmail.com'],
    ['g-4', 'firstboitier3@gmail.com'],
    ['g-5', 'boitierfirst7@gmail.com'],
    ['g-6', 'boitierfirst8@gmail.com'],
    ['g-7', 'boitierfirst82@gmail.com'],
    ['g-8', 'saturninyoukpo8@gmail.com'],
    ['g-9', 'saturninyoukpo13@gmail.com'],
  ].map(([accountId, email]) => ({
    accountId,
    name: email.split('@')[0],
    email,
    usedBytes: 10,
    quotaBytes: 100,
    status: 'connected',
  }));

  const notes = [];
  let appels = 0;
  const reprise = await parcours({
    label: 'coffre joignable au second essai',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [
          {
            id: 'gdrive-real-g-1',
            googleId: 'g-1',
            source: 'google',
            provider: 'gdrive',
            name: 'boitierecup',
            email: 'boitierecup@gmail.com',
            usedBytes: 10,
            quotaBytes: 100,
            status: 'connected',
            createdAt: '2026-11-01T10:00:00.000Z',
            seed: 7,
            localTree: false,
          },
        ],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: 'gdrive-real-g-1', path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      note: (message) => notes.push(message),
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => {
          appels += 1;
          if (appels === 1) throw new Error('canal pas encore prêt');
          return neuf;
        },
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
      mega: { accounts: async () => [], onUpload: () => () => {} },
    },
  });

  check(
    'comptes : une lecture en échec est retentée automatiquement',
    appels >= 2,
    `${appels} appel(s)`,
  );
  check(
    'comptes : après réessai, les neuf comptes sont à l’écran',
    neuf.every((info) => reprise.after['Google Drive'].includes(info.email)) &&
      /9 comptes/.test(reprise.after['Google Drive']),
    reprise.after['Google Drive'].match(/\d+ comptes? connectés?/)?.[0] ?? 'compteur absent',
  );
  check(
    'comptes : l’échec de lecture laisse une trace dans le journal',
    notes.some((message) => /lecture du coffre échouée/.test(message)),
    notes[0] ?? 'aucune note',
  );
  check(
    'comptes : le nombre de comptes affichés est noté',
    notes.some((message) => /compte\(s\) Google à l'écran/.test(message)),
    notes.join(' | ').slice(0, 90),
  );

  const parametres = reprise.doc;
  const boutonReafficher = [...parametres.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === 'Réafficher',
  );
  check(
    'paramètres : un bouton permet de rétablir les comptes du coffre',
    Boolean(boutonReafficher),
    boutonReafficher ? 'présent' : 'absent',
  );
}

/* --- 14. Même adresse des deux côtés : les comptes ne se recouvrent plus --- */
//
// Incident réel : les mêmes adresses Gmail servent de compte Google Drive **et**
// de compte MEGA. L'appariement se faisait par adresse seule, si bien que le
// compte MEGA adoptait l'identifiant du compte Google (et inversement). D'où un
// inventaire figé à treize comptes qui basculait sans cesse entre
// « 9 Google · 4 MEGA » et « 2 Google · 11 MEGA ».
{
  const adresses = [
    'boitierecup@gmail.com',
    'firstboitier1@gmail.com',
    'firstboitier2@gmail.com',
    'firstboitier3@gmail.com',
    'boitierfirst7@gmail.com',
    'boitierfirst8@gmail.com',
    'boitierfirst82@gmail.com',
    'saturninyoukpo8@gmail.com',
    'saturninyoukpo13@gmail.com',
  ];

  const coffre = adresses.map((email, index) => ({
    accountId: `gdrive-h${index}`,
    name: email.split('@')[0],
    email,
    usedBytes: 10,
    quotaBytes: 100,
    status: 'connected',
  }));

  // État enregistré, abîmé : onze comptes MEGA dont sept portent un identifiant
  // Google (celui qu'ils ont volé), et deux comptes Google seulement.
  const mega = Array.from({ length: 11 }, (_, index) => {
    const adresse = adresses[index] ?? `mega${index}@exemple.com`;
    const volé = index < 7;
    return {
      id: volé ? `gdrive-real-gdrive-h${index}` : `mega-real-m${index}`,
      megaId: `m${index}`,
      source: 'mega',
      provider: 'mega',
      name: adresse.split('@')[0],
      email: adresse,
      usedBytes: 1,
      quotaBytes: 20,
      status: 'connected',
      createdAt: '2026-11-01T10:00:00.000Z',
      seed: 11,
      localTree: false,
    };
  });

  const google = coffre.slice(0, 2).map((info) => ({
    id: `gdrive-real-${info.accountId}`,
    googleId: info.accountId,
    source: 'google',
    provider: 'gdrive',
    name: info.name,
    email: info.email,
    usedBytes: info.usedBytes,
    quotaBytes: info.quotaBytes,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 7,
    localTree: false,
  }));

  const notes = [];
  const cohabitation = await parcours({
    label: 'mêmes adresses des deux côtés',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [...google, ...mega],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: google[0].id, path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      note: (message) => notes.push(message),
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => coffre,
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
      },
      mega: {
        accounts: async () =>
          mega.map((compte, index) => ({
            accountId: `m${index}`,
            name: compte.name,
            email: compte.email,
            usedBytes: 1,
            quotaBytes: 20,
            status: 'connected',
          })),
        onUpload: () => () => {},
        list: async () => [],
      },
    },
  });

  const page = cohabitation.after['Google Drive'];
  check(
    'mêmes adresses : les neuf comptes Google coexistent',
    adresses.every((email) => page.includes(email)) && /9 comptes/.test(page),
    page.match(/\d+ comptes? connectés?/)?.[0] ?? 'compteur absent',
  );
  const sidebar = [...cohabitation.doc.querySelectorAll('.cloud-item')]
    .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
    .join(' | ');
  check(
    'mêmes adresses : les onze comptes MEGA restent entiers',
    /MEGA ?11/.test(sidebar),
    sidebar.slice(0, 90),
  );
  // La première note peut légitimement annoncer l'état enregistré (2) : c'est
  // la synchronisation qui rétablit 9. Ce qui doit avoir disparu, c'est
  // l'alternance 9 → 2 → 9 qui trahissait le recouvrement des identifiants.
  const suite = notes
    .map((message) => /comptes : (\d+) compte\(s\) Google/.exec(message)?.[1])
    .filter((valeur) => valeur !== undefined)
    .map(Number);
  const pic = suite.indexOf(9);
  check(
    'mêmes adresses : l’inventaire ne bascule plus après le rétablissement',
    pic >= 0 && suite.slice(pic).every((valeur) => valeur === 9),
    suite.join(' → '),
  );
}

/* --- 15. Stockage : un groupe par fournisseur ----------------------------- */
//
// Incident réel : vingt pastilles mêlant Google Drive et MEGA dans une seule
// liste, et un compte MEGA sélectionné affichait « Seul un compte Google
// connecté expose un quota réel » — alors que son quota est parfaitement connu.
{
  const google = [
    { id: 'gdrive-real-g1', googleId: 'g1', email: 'boitierecup@gmail.com' },
    { id: 'gdrive-real-g2', googleId: 'g2', email: 'firstboitier1@gmail.com' },
  ].map((compte, index) => ({
    ...compte,
    source: 'google',
    provider: 'gdrive',
    name: compte.email.split('@')[0],
    usedBytes: 4 * 1024 ** 3,
    quotaBytes: 15 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 7 + index,
    localTree: false,
  }));

  const mega = [
    { id: 'mega-real-m1', megaId: 'm1', email: 'firstboitier1@gmail.com' },
    { id: 'mega-real-m2', megaId: 'm2', email: 'boitierfirst7@gmail.com' },
  ].map((compte, index) => ({
    ...compte,
    source: 'mega',
    provider: 'mega',
    name: compte.email.split('@')[0],
    usedBytes: 18 * 1024 ** 3,
    quotaBytes: 20 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 11 + index,
    localTree: false,
  }));

  const stockage = await parcours({
    label: 'stockage séparé',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [...google, ...mega],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: google[0].id, path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        storage: async () => ({ usedBytes: 0, categories: [] }),
      },
      mega: { accounts: async () => [], onUpload: () => () => {}, list: async () => [] },
    },
  });

  const versStockage = [...stockage.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Stockage'),
  );
  if (versStockage) await stockage.click(versStockage);

  const groupes = [...stockage.doc.querySelectorAll('.storage-group')].map((element) =>
    (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
  check(
    'stockage : les comptes sont groupés par fournisseur',
    groupes.length === 2 &&
      /Google Drive/.test(groupes[0]) &&
      /MEGA/.test(groupes[1]),
    `${groupes.length} groupe(s) : ${groupes.map((groupe) => groupe.slice(0, 40)).join(' | ')}`,
  );
  check(
    'stockage : chaque groupe annonce son propre total',
    /2 comptes/.test(groupes[0] ?? '') &&
      /2 comptes/.test(groupes[1] ?? '') &&
      /8,0 Go/.test(groupes[0] ?? '') &&
      /36,0 Go/.test(groupes[1] ?? ''),
    `${groupes[0]?.slice(0, 60)} / ${groupes[1]?.slice(0, 60)}`,
  );

  // Sélection d'un compte MEGA : le quota est réel, le texte ne doit plus dire
  // le contraire.
  const pastilleMega = [...stockage.doc.querySelectorAll('.segmented__item')].find(
    (button) => (button.textContent ?? '').includes('boitierfirst7'),
  );
  check('stockage : une pastille MEGA est proposée', Boolean(pastilleMega));
  if (pastilleMega) await stockage.click(pastilleMega);
  const corps = stockage.doc.body.textContent ?? '';
  check(
    'stockage : un compte MEGA affiche son quota, pas un refus',
    !/Seul un compte Google connecté expose un quota réel/.test(corps) &&
      !/Compte sans mesure disponible/.test(corps) &&
      /18,0 Go/.test(corps),
    corps.match(/Seul un compte Google[^.]*\./)?.[0] ?? 'texte correct',
  );
  check(
    'stockage : l’absence de détail par type est expliquée, pas affichée à zéro',
    /sans détail par type/.test(corps),
    'explication absente',
  );
}

/* --- 16. Dossier MEGA, dossier commun et logos des clouds ---------------- */
//
// Trois demandes de l'utilisateur, vérifiées ensemble parce qu'elles se
// rejoignent dans la même file :
//
//   • un dossier MEGA se télécharge entier, comme un dossier Google Drive ;
//   • tout atterrit sous `Téléchargements\\BOITIER-CLOUD-MANAGER\\<cloud>` ;
//   • chaque cloud porte son vrai logo, jamais une initiale dans un carré.
{
  const dossierCommun = 'C:\\Users\\BOITIER_FIRST\\Downloads\\BOITIER-CLOUD-MANAGER';
  const megaCompte = {
    id: 'mega-real-m9',
    megaId: 'm9',
    email: 'firstboitier1@gmail.com',
    source: 'mega',
    provider: 'mega',
    name: 'firstboitier1',
    usedBytes: 18 * 1024 ** 3,
    quotaBytes: 20 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 11,
    localTree: false,
  };
  const googleCompte = {
    id: 'gdrive-real-g9',
    googleId: 'g9',
    email: 'boitierecup@gmail.com',
    source: 'google',
    provider: 'gdrive',
    name: 'boitierecup',
    usedBytes: 4 * 1024 ** 3,
    quotaBytes: 15 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 7,
    localTree: false,
  };

  /** Tout ce que l'interface demande au processus principal. */
  const demandes = [];
  const planCalls = [];

  const mega = await parcours({
    label: 'dossier MEGA',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [googleCompte, megaCompte],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: megaCompte.id, path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [],
        folder: async () => dossierCommun,
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        storage: async () => ({ usedBytes: 0, categories: [] }),
      },
      mega: {
        accounts: async () => [],
        onUpload: () => () => {},
        folder: async () => dossierCommun,
        list: async () => [
          {
            id: 'mf1',
            name: 'Series',
            kind: 'folder',
            size: 0,
            modified: '2026-11-02T10:00:00.000Z',
          },
        ],
        plan: async (accountId, folderId) => {
          planCalls.push(`${accountId}:${folderId}`);
          return {
            files: [
              { fileId: 'x1', path: 'Saison 1/ep1.mkv', size: 1_200_000, mimeType: 'video/x-matroska' },
              { fileId: 'x2', path: 'Saison 1/ep2.mkv', size: 800_000, mimeType: 'video/x-matroska' },
            ],
            folders: ['Saison 1'],
            skipped: [],
            truncated: false,
            totalBytes: 2_000_000,
          };
        },
        download: async (request) => {
          demandes.push(request);
        },
        pause: async () => {},
        resume: async () => true,
        cancel: async () => {},
      },
    },
  });

  /** Ouvre un écran de la navigation par son libellé. */
  const aller = async (nom) => {
    const cible = [...mega.doc.querySelectorAll('.nav-item, .cloud-item')].find((button) =>
      (button.textContent ?? '').includes(nom),
    );
    if (cible) await mega.click(cible);
    await new Promise((r) => setTimeout(r, 250));
    return Boolean(cible);
  };

  // 16.a — les logos remplacent les initiales (visibles sur l'accueil, qui
  // présente un fournisseur par carte).
  await aller('Accueil');
  const pastilles = [...mega.doc.querySelectorAll('.provider-mark')];
  check(
    'logos : chaque fournisseur affiche un dessin, pas une lettre',
    pastilles.length > 0 &&
      pastilles.every((element) => element.querySelector('svg, img') && !(element.textContent ?? '').trim()),
    `${pastilles.length} pastille(s) : ${pastilles.map((e) => (e.textContent ?? '').trim() || 'svg').join(', ')}`,
  );
  check(
    'logos : aucune initiale « G » ou « M » dans un carré',
    ![...mega.doc.querySelectorAll('.provider-mark')].some((element) =>
      /^[GM]$/.test((element.textContent ?? '').trim()),
    ),
  );
  check(
    'logos : Google Drive et MEGA ont chacun leur dessin',
    (mega.doc.querySelectorAll('.provider-mark svg path').length ?? 0) >= 4,
    'un seul dessin générique',
  );

  // 16.b — le dossier MEGA se prépare puis se télécharge depuis la file.
  await aller('Tous les fichiers');
  const boutonDossier = mega.doc.querySelector('[aria-label^="Télécharger le dossier"]');
  check('dossier MEGA : commande de téléchargement complet présente', Boolean(boutonDossier));
  if (boutonDossier) {
    await mega.click(boutonDossier);
    await new Promise((r) => setTimeout(r, 250));
    const dialogue = mega.doc.querySelector('.modal')?.textContent ?? '';
    check(
      'dossier MEGA : le plan vient de MEGA, pas de Google',
      planCalls.some((appel) => appel.startsWith('m9:')),
      planCalls.join(', ') || 'aucun parcours demandé',
    );
    check('dossier MEGA : résumé annoncé avant tout transfert', /2 fichiers/.test(dialogue), dialogue.trim().slice(0, 90));
    check(
      'dossier MEGA : destination sous le dossier commun, puis le cloud',
      /BOITIER-CLOUD-MANAGER/.test(dialogue) && /MEGA/.test(dialogue),
      dialogue.match(/Destination[^\n]*/)?.[0] ?? 'destination absente',
    );
    const confirmer = [...mega.doc.querySelectorAll('.modal__foot .btn')].find(
      (button) => (button.textContent ?? '').trim() === 'Télécharger',
    );
    check('dossier MEGA : bouton de confirmation présent', Boolean(confirmer));
    if (confirmer) {
      await mega.click(confirmer);
      await new Promise((r) => setTimeout(r, 400));
      check(
        'dossier MEGA : deux transferts réellement lancés',
        demandes.length === 2,
        `${demandes.length} demande(s)`,
      );
      check(
        'dossier MEGA : chaque fichier part sous le cloud puis son arborescence',
        demandes.every((demande) => /^MEGA\/Series/.test(demande.subPath ?? '')),
        demandes.map((demande) => demande.subPath).join(' | ') || 'aucun sous-chemin',
      );
      const versTelechargements = [...mega.doc.querySelectorAll('.nav-item')].find((button) =>
        (button.textContent ?? '').includes('Téléchargements'),
      );
      if (versTelechargements) await mega.click(versTelechargements);
      const file = [...mega.doc.querySelectorAll('.download-row__name')].map(
        (row) => row.textContent ?? '',
      );
      check(
        'dossier MEGA : la file reprend l’arborescence du dossier',
        file.some((nom) => nom.includes('ep1.mkv')) && file.some((nom) => nom.includes('ep2.mkv')),
        file.join(', ') || 'file vide',
      );
    }
  }

  // 16.c — depuis l'intérieur d'un dossier, on peut aussi le télécharger.
  await aller('Tous les fichiers');
  const ouvrir = mega.doc.querySelector('[aria-label^="Ouvrir Series"]');
  if (ouvrir) {
    await mega.click(ouvrir);
    await new Promise((r) => setTimeout(r, 250));
    const boutonCourant = mega.doc.querySelector('.folder-download');
    check(
      'dossier MEGA : le dossier ouvert se télécharge depuis la barre d’outils',
      Boolean(boutonCourant) && /Ce dossier/.test(boutonCourant.textContent ?? ''),
      boutonCourant?.textContent?.trim() ?? 'bouton absent',
    );
  } else {
    check('dossier MEGA : bouton « Ouvrir » présent', false, 'absent');
  }
}

/* --- 17. Un compte MEGA bloqué ne parle plus de Google Drive ------------- */
//
// Incident réel : un compte MEGA affichait « Google Drive est injoignable » et,
// en dessous, le texte brut d'Electron :
//
//   Error invoking remote method 'mega:list': Error: EBLOCKED (-16): User blocked
//
// Le fournisseur était faux et l'explication absente. MEGA bloque un compte
// quand trop de connexions arrivent d'un coup : c'est ce qu'il faut dire.
{
  const megaCompte = {
    id: 'mega-real-b7',
    megaId: 'b7',
    email: 'boitierfirst7@gmail.com',
    source: 'mega',
    provider: 'mega',
    name: 'boitierfirst7',
    usedBytes: 18 * 1024 ** 3,
    quotaBytes: 20 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 13,
    localTree: false,
  };

  const bloque = await parcours({
    label: 'MEGA bloqué',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [megaCompte],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: megaCompte.id, path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [],
        folder: async () => 'C:\\Users\\BOITIER_FIRST\\Downloads\\BOITIER-CLOUD-MANAGER',
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        storage: async () => ({ usedBytes: 0, categories: [] }),
      },
      mega: {
        accounts: async () => [],
        onUpload: () => () => {},
        // La forme exacte relevée dans le journal de l'utilisateur.
        list: async () => {
          throw new Error(
            "Error invoking remote method 'mega:list': Error: EBLOCKED (-16): User blocked",
          );
        },
      },
    },
  });

  const versFichiers = [...bloque.doc.querySelectorAll('.nav-item')].find((button) =>
    (button.textContent ?? '').includes('Tous les fichiers'),
  );
  if (versFichiers) await bloque.click(versFichiers);
  await new Promise((r) => setTimeout(r, 300));

  const titre = bloque.doc.querySelector('.filetable-error__title')?.textContent?.trim() ?? '';
  const texte = bloque.doc.querySelector('.filetable-error__text')?.textContent?.trim() ?? '';
  check(
    'MEGA bloqué : l’écran nomme le bon fournisseur',
    /MEGA : compte bloqué/.test(titre) && !/Google Drive|injoignable/.test(titre),
    titre || 'titre absent',
  );
  check(
    'MEGA bloqué : le blocage est expliqué, en français',
    /compte est bloqué/i.test(texte) && /patientez/i.test(texte),
    texte,
  );
  check(
    'MEGA bloqué : aucun texte technique à l’écran',
    !/Error invoking remote method|EBLOCKED|User blocked/.test(texte),
    'texte brut encore affiché',
  );
  check(
    'MEGA bloqué : un nouvel essai reste possible',
    Boolean(
      [...bloque.doc.querySelectorAll('.filetable-error .btn')].find((button) =>
        /Réessayer/.test(button.textContent ?? ''),
      ),
    ),
  );
  check(
    'MEGA bloqué : le compte n’est pas retiré de la liste',
    /boitierfirst7/.test(bloque.doc.body.textContent ?? ''),
    'compte disparu',
  );
  check('explorateur MEGA : aucun bouton pour ouvrir Google Drive',
    !/Ouvrir dans Drive/.test(bloque.doc.body.textContent ?? ''));
  let compteEnvoi = '';
  bloque.window.boitier.mega.upload = async (accountId) => { compteEnvoi = accountId; return { sent: 0 }; };
  const envoi = [...bloque.doc.querySelectorAll('button')].find((button) => /Envoyer sur MEGA/.test(button.textContent ?? ''));
  if (envoi) await bloque.click(envoi);
  check('explorateur MEGA : l’envoi utilise l’identifiant MEGA', compteEnvoi === 'b7', compteEnvoi);
}

/* --- 18. Ligne MEGA de l'écran Clouds : les bons boutons ------------------ */
//
// La ligne de compte était écrite pour Google et servait aux deux fournisseurs :
// sur un compte MEGA, « Reconnecter » ouvrait le dialogue **Google**, le
// rafraîchissement du quota interrogeait Google avec un identifiant MEGA, et le
// badge annonçait « Lecture seule » alors que MEGA autorise aussi l'envoi.
{
  const googleCompte = {
    id: 'gdrive-real-c1',
    googleId: 'c1',
    email: 'boitierecup@gmail.com',
    source: 'google',
    provider: 'gdrive',
    name: 'Boitier First Recup',
    usedBytes: 4 * 1024 ** 3,
    quotaBytes: 15 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 7,
    localTree: false,
  };
  const megaCompte = {
    id: 'mega-real-c2',
    megaId: 'c2',
    email: 'firstboitier2@gmail.com',
    source: 'mega',
    provider: 'mega',
    name: 'firstboitier2',
    usedBytes: 12 * 1024 ** 3,
    quotaBytes: 20 * 1024 ** 3,
    status: 'connected',
    createdAt: '2026-11-01T10:00:00.000Z',
    seed: 11,
    localTree: false,
  };

  const appels = { megaUsage: 0, googleRefresh: 0, megaConnect: 0 };
  const nuage = await parcours({
    label: 'ligne MEGA',
    storage: {
      key: 'boitier-cloud-manager:v1',
      value: {
        version: 1,
        accounts: [googleCompte, megaCompte],
        favorites: [],
        downloads: [],
        settings: {},
        explorer: { accountId: megaCompte.id, path: [] },
      },
    },
    bridge: {
      platform: 'win32',
      ready: async () => true,
      google: {
        status: async () => ({ configured: true, source: 'env' }),
        accounts: async () => [],
        onDownload: () => () => {},
        list: async () => [],
        search: async () => [],
        shared: async () => [],
        recent: async () => [],
        storage: async () => ({ usedBytes: 0, categories: [] }),
        refresh: async () => {
          appels.googleRefresh += 1;
          return null;
        },
      },
      mega: {
        accounts: async () => [
          {
            accountId: 'c2',
            name: 'firstboitier2',
            email: 'firstboitier2@gmail.com',
            usedBytes: 13 * 1024 ** 3,
            quotaBytes: 20 * 1024 ** 3,
            status: 'connected',
          },
        ],
        onUpload: () => () => {},
        list: async () => [],
        usage: async () => {
          appels.megaUsage += 1;
          return { usedBytes: 13 * 1024 ** 3, quotaBytes: 20 * 1024 ** 3 };
        },
        connect: async () => {
          appels.megaConnect += 1;
          return {
            accountId: 'c2',
            name: 'firstboitier2',
            email: 'firstboitier2@gmail.com',
            usedBytes: 13 * 1024 ** 3,
            quotaBytes: 20 * 1024 ** 3,
            status: 'connected',
          };
        },
      },
    },
  });

  const versMega = [...nuage.doc.querySelectorAll('.nav-item, .cloud-item')].find((button) =>
    /MEGA/.test(button.textContent ?? ''),
  );
  if (versMega) await nuage.click(versMega);
  await new Promise((r) => setTimeout(r, 300));

  const ligne = nuage.doc.querySelector('.account-row');
  const ligneTexte = (ligne?.textContent ?? '').replace(/\s+/g, ' ');
  check('ligne MEGA : le compte est affiché', /firstboitier2/.test(ligneTexte), ligneTexte.slice(0, 80));
  check(
    'ligne MEGA : le badge décrit ce que MEGA permet vraiment',
    /Lecture et envoi/.test(ligneTexte) && !/Lecture seule/.test(ligneTexte),
    ligneTexte.slice(0, 120),
  );

  // Rafraîchir le quota : la mesure MEGA, pas celle de Google.
  const rafraichir = ligne?.querySelector('[title^="Rafraîchir le quota"]');
  check(
    'ligne MEGA : le rafraîchissement du quota nomme MEGA',
    /depuis MEGA/.test(rafraichir?.getAttribute('title') ?? ''),
    rafraichir?.getAttribute('title') ?? 'bouton absent',
  );
  if (rafraichir) {
    await nuage.click(rafraichir);
    await new Promise((r) => setTimeout(r, 250));
  }
  check(
    'ligne MEGA : le quota est relu chez MEGA, jamais chez Google',
    appels.megaUsage === 1 && appels.googleRefresh === 0,
    `mega.usage ${appels.megaUsage} · google.refresh ${appels.googleRefresh}`,
  );

  // Reconnecter : le dialogue MEGA, adresse préremplie, aucune mention Google.
  const reconnecter = ligne?.querySelector('[aria-label^="Reconnecter"]');
  check(
    'ligne MEGA : « Reconnecter » parle de la session MEGA',
    /rouvrir la session MEGA/.test(reconnecter?.getAttribute('title') ?? ''),
    reconnecter?.getAttribute('title') ?? 'bouton absent',
  );
  if (reconnecter) {
    await nuage.click(reconnecter);
    await new Promise((r) => setTimeout(r, 250));
  }
  const dialogue = nuage.doc.querySelector('.modal');
  const titreDialogue = dialogue?.querySelector('.modal__title')?.textContent?.trim() ?? '';
  const corpsDialogue = (dialogue?.textContent ?? '').replace(/\s+/g, ' ');
  check(
    'ligne MEGA : la reconnexion ouvre le dialogue MEGA',
    /Reconnecter firstboitier2/.test(titreDialogue) && /MEGA/.test(corpsDialogue),
    titreDialogue || 'aucun dialogue',
  );
  check(
    'ligne MEGA : la reconnexion ne parle pas de Google',
    !/Google|autorisation/i.test(corpsDialogue),
    corpsDialogue.slice(0, 100),
  );
  check(
    'ligne MEGA : l’adresse est préremplie',
    dialogue?.querySelector('#mega-email')?.value === 'firstboitier2@gmail.com',
    dialogue?.querySelector('#mega-email')?.value ?? 'champ absent',
  );
  check(
    'ligne MEGA : la fiche du compte est conservée (aucun doublon annoncé)',
    /conservés/.test(corpsDialogue),
    'promesse absente',
  );

  // La reconnexion aboutit : la session est rouverte et le compte reste unique.
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(
      nuage.window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new nuage.window.Event('input', { bubbles: true }));
  };
  const motDePasse = dialogue?.querySelector('#mega-password');
  if (motDePasse) setValue(motDePasse, 'mot-de-passe-de-test');
  await new Promise((r) => setTimeout(r, 120));
  const valider = [...nuage.doc.querySelectorAll('.modal__foot .btn')].find((button) =>
    /Se reconnecter/.test(button.textContent ?? ''),
  );
  check('ligne MEGA : le bouton « Se reconnecter » est proposé', Boolean(valider));
  if (valider) {
    await nuage.click(valider);
    await new Promise((r) => setTimeout(r, 300));
  }
  check(
    'ligne MEGA : la reconnexion rouvre vraiment la session',
    appels.megaConnect === 1,
    `${appels.megaConnect} appel(s) de connexion`,
  );
  check(
    'ligne MEGA : aucun compte en double après reconnexion',
    nuage.doc.querySelectorAll('.account-row').length === 1,
    `${nuage.doc.querySelectorAll('.account-row').length} ligne(s)`,
  );

  // Côté Google, rien ne change : lecture seule et autorisation Google.
  const versGoogle = [...nuage.doc.querySelectorAll('.cloud-item, .nav-item')].find((button) =>
    /Google Drive/.test(button.textContent ?? ''),
  );
  if (versGoogle) await nuage.click(versGoogle);
  await new Promise((r) => setTimeout(r, 300));
  const ligneGoogle = nuage.doc.querySelector('.account-row');
  const texteGoogle = (ligneGoogle?.textContent ?? '').replace(/\s+/g, ' ');
  check(
    'ligne Google : le badge reste « Lecture seule »',
    /Lecture seule/.test(texteGoogle),
    texteGoogle.slice(0, 100),
  );
  check(
    'ligne Google : « Reconnecter » renouvelle l’autorisation Google',
    /autorisation Google/.test(
      ligneGoogle?.querySelector('[aria-label^="Reconnecter"]')?.getAttribute('title') ?? '',
    ),
  );
}

/* --- Grand dossier : le DOM reste borné sans perdre les fichiers --------- */
{
  const gros = Array.from({ length: 230 }, (_, i) => ({
    id: `large-${i}`, name: `Fichier ${String(i).padStart(3, '0')}.pdf`,
    kind: 'file', mimeType: 'application/pdf', size: 1000,
    modified: '2026-01-01T00:00:00.000Z',
  }));
  const pont = compte.window.boitier;
  const grand = await parcours({
    label: 'grand dossier',
    bridge: { ...pont, google: { ...pont.google, list: async () => gros } },
  });
  const fichiers = [...grand.doc.querySelectorAll('.nav-item')].find((button) =>
    /Tous les fichiers/.test(button.textContent ?? ''),
  );
  if (fichiers) await grand.click(fichiers);
  await new Promise((r) => setTimeout(r, 350));
  check('grand dossier : 100 lignes au départ', grand.doc.querySelectorAll('.filetable tbody tr').length === 100,
    `${grand.doc.querySelectorAll('.filetable tbody tr').length} lignes`);
  const tout = grand.doc.querySelector('[aria-label="Tout sélectionner (tous les résultats)"]');
  if (tout) await grand.click(tout);
  check('grand dossier : sélection de tous les résultats même non affichés', /230 sélectionnés/.test(grand.text()));
  if (tout) await grand.click(tout);
  const nom = grand.doc.querySelector('.filetable thead th.is-sortable');
  if (nom) await grand.click(nom);
  check('grand dossier : le tri s’applique aux lignes affichées', /Fichier 229\.pdf/.test(grand.doc.querySelector('.filetable tbody tr')?.textContent ?? ''));
  if (nom) await grand.click(nom);
  const suivant = [...grand.doc.querySelectorAll('button')].find((button) => /^Suivant$/.test(button.textContent?.trim() ?? ''));
  check('grand dossier : les fichiers suivants restent accessibles', Boolean(suivant));
  if (suivant) await grand.click(suivant);
  check('grand dossier : 100 lignes sur la deuxième page', grand.doc.querySelectorAll('.filetable tbody tr').length === 100);
  check('grand dossier : la deuxième page commence au fichier 100', /Fichier 100\.pdf/.test(grand.doc.querySelector('.filetable tbody tr')?.textContent ?? ''));
  if (suivant) await grand.click(suivant);
  check('grand dossier : dernière page de 30 fichiers', grand.doc.querySelectorAll('.filetable tbody tr').length === 30);
  check('grand dossier : dernier fichier présent', /Fichier 229\.pdf/.test(grand.text()));
  const precedent = [...grand.doc.querySelectorAll('button')].find((button) => /^Précédent$/.test(button.textContent?.trim() ?? ''));
  if (precedent) await grand.click(precedent);
  check('grand dossier : retour à la page précédente', /Fichier 100\.pdf/.test(grand.doc.querySelector('.filetable tbody tr')?.textContent ?? ''));
  grand.window.close();
}

/* --- Shadow : branchement interface et identité du compte ---------------- */
{
  const calls = [];
  const info = { accountId: 'shadow-test', name: 'mon-compte', username: 'mon-compte', url: 'https://drive.shadow.tech/remote.php/webdav/', usedBytes: 12, quotaBytes: 100, status: 'connected' };
  const screen = await parcours({ label: 'Shadow Drive', bridge: {
    platform: 'win32', ready: async () => true,
    google: { status: async () => ({ configured: true }), accounts: async () => [], onDownload: () => () => {}, list: async () => { calls.push('google-list'); return []; }, recent: async () => [], search: async () => [], shared: async () => [] },
    shadow: {
      accounts: async () => [],
      connect: async (user, token, url, expected) => { calls.push(['connect', user, token, url, expected]); return info; },
      disconnect: async (id) => { calls.push(['disconnect', id]); },
      list: async (id, folder) => { calls.push(['list', id, folder]); return [{ id: 'f1', name: 'preuve.txt', kind: 'file', size: 12, modified: new Date().toISOString() }]; },
      search: async () => [], recent: async () => [], usage: async () => ({ usedBytes: 12, quotaBytes: 100 }),
    },
  }});
  const nav = [...screen.doc.querySelectorAll('.cloud-item')].find((e) => e.textContent.includes('Shadow Drive'));
  if (nav) await screen.click(nav);
  const add = [...screen.doc.querySelectorAll('button')].find((e) => e.textContent.includes('Connecter Shadow Drive'));
  check('Shadow : fournisseur et bouton de connexion visibles', Boolean(nav && add));
  if (add) await screen.click(add);
  const setInput = (id, value) => {
    const input = screen.doc.querySelector(id);
    if (!input) return;
    Object.getOwnPropertyDescriptor(screen.window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new screen.window.Event('input', { bubbles: true }));
  };
  setInput('#shadow-user', 'mon-compte'); setInput('#shadow-token', 'jeton-test');
  await new Promise((r) => setTimeout(r, 100));
  const submit = [...screen.doc.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Se connecter');
  if (submit) await screen.click(submit);
  check('Shadow : connexion transmise au pont dédié', calls.some((x) => Array.isArray(x) && x[0] === 'connect' && x[1] === 'mon-compte' && x[2] === 'jeton-test'));
  const open = [...screen.doc.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Ouvrir');
  if (open) await screen.click(open);
  check('Shadow : fichiers lus avec l’identifiant fournisseur', calls.some((x) => Array.isArray(x) && x[0] === 'list' && x[1] === 'shadow-test') && screen.text().includes('preuve.txt'));
  check('Shadow : exploration sans appel Google accidentel', !calls.includes('google-list'));
  if (nav) await screen.click(nav);
  const disconnect = [...screen.doc.querySelectorAll('button')].find((e) => (e.title ?? '').startsWith('Déconnecter'));
  if (disconnect) await screen.click(disconnect);
  const confirm = [...screen.doc.querySelectorAll('button')].find((e) => e.textContent.trim() === 'Déconnecter');
  if (confirm) await screen.click(confirm);
  check('Shadow : dernier compte retiré du coffre et de la liste', calls.some((x) => Array.isArray(x) && x[0] === 'disconnect' && x[1] === 'shadow-test') && screen.text().includes('Aucun compte connecté'));
  screen.window.close();
}

console.log(
  failures === 0
    ? '\nInterface vérifiée : état vide maîtrisé, compte réel affiché, aucun décor.'
    : `\n${failures} problème(s) détecté(s).`,
);
process.exit(failures === 0 ? 0 : 1);
