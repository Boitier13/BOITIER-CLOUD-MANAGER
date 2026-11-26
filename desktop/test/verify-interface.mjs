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
async function parcours({ label, bridge, storage }) {
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
        download: async () => {
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
    check(
      'destination : le chemin réel du dossier apparaît devant la barre',
      dest.trim() === 'C:\\Users\\Saturnin\\Downloads',
      dest.trim() || 'aucun chemin',
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

console.log(
  failures === 0
    ? '\nInterface vérifiée : état vide maîtrisé, compte réel affiché, aucun décor.'
    : `\n${failures} problème(s) détecté(s).`,
);
process.exit(failures === 0 ? 0 : 1);
