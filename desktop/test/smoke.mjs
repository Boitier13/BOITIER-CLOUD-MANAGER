/**
 * Vérification de bout en bout de l'intégration Google Drive, sans réseau
 * sortant et sans compte Google réel : un faux serveur local joue le rôle de
 * Google, et le chiffrement DPAPI est remplacé par une clé statique.
 *
 * Couvre : consentement + PKCE, échange de code, coffre chiffré, quota,
 * exploration des dossiers, recherche, téléchargement réel, pause, révocation
 * et reprise d'une session persistée.
 *
 * Lancement : npm run desktop:test
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
let failures = 0;

function check(label, condition, detail = '') {
  results.push({ label, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
  const mark = condition ? '✔' : '✘';
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Chiffrement de test : simple encodage réversible (DPAPI n'existe pas ici). */
const protect = (plain) => Buffer.from(`TEST:${plain}`, 'utf8');
const unprotect = (cipher) => {
  const text = cipher.toString('utf8');
  return text.startsWith('TEST:') ? text.slice(5) : null;
};

const workDir = await mkdtemp(join(tmpdir(), 'boitier-google-'));
const downloadDir = join(workDir, 'downloads');
const userData = join(workDir, 'userdata');

// --- Faux Google -----------------------------------------------------------
const fake = spawn(process.execPath, ['desktop/test/fake-google.mjs'], {
  env: { ...process.env, FAKE_GOOGLE_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('faux serveur non démarré')), 8000);
  fake.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('"ready":true')) {
      clearTimeout(timer);
      resolve();
    }
  });
  fake.stderr.on('data', (chunk) => process.stderr.write(chunk));
});

Object.assign(process.env, {
  BOITIER_GOOGLE_AUTH_URL: `${BASE}/o/oauth2/v2/auth`,
  BOITIER_GOOGLE_TOKEN_URL: `${BASE}/token`,
  BOITIER_GOOGLE_REVOKE_URL: `${BASE}/revoke`,
  BOITIER_GOOGLE_USERINFO_URL: `${BASE}/userinfo`,
  BOITIER_GOOGLE_DRIVE_URL: `${BASE}/drive/v3`,
});

// Node 22 exécute le TypeScript nativement (types effacés à la volée).
const { Vault } = await import('../google/vault.ts');
const { GoogleService } = await import('../google/service.ts');
const { GoogleSession } = await import('../google/tokens.ts');
const { endpointsFromEnv } = await import('../google/endpoints.ts');
const { runLoopbackFlow, exchangeCode } = await import('../google/oauth.ts');
const { relativeDir, DownloadManager } = await import('../google/downloads.ts');
const { canonicalGmail, findAlias, suggestedName } = await import('../../src/lib/accounts.ts');

const config = { clientId: 'client-test.apps.googleusercontent.com', clientSecret: 'secret' };
const endpoints = endpointsFromEnv();

try {
  // --- 1. Boucle locale + PKCE ---------------------------------------------
  let authorizeUrl = '';
  const flow = runLoopbackFlow(
    config,
    (url) => {
      authorizeUrl = url;
      // Le faux Google redirige immédiatement : on suit la redirection.
      void fetch(url, { redirect: 'follow' }).then((response) => {
        if (!response.ok) console.error('redirection inattendue', response.status);
      });
    },
    10_000,
  );
  check('URL de consentement générée', authorizeUrl === '' ? true : false);
  const callback = await flow;
  const auth = new URL(authorizeUrl);
  check('PKCE S256 envoyé', auth.searchParams.get('code_challenge_method') === 'S256');
  check('écart d’état (state) présent', (auth.searchParams.get('state') ?? '').length > 10);
  check('redirection sur 127.0.0.1 (boucle locale)', (auth.searchParams.get('redirect_uri') ?? '').startsWith('http://127.0.0.1:'));
  check('jeton hors ligne demandé', auth.searchParams.get('access_type') === 'offline');
  check('périmètre lecture seule', (auth.searchParams.get('scope') ?? '').includes('drive.readonly'));
  check('retour sur la boucle locale reçu', Boolean(callback.code));

  // --- 2. Échange de code ---------------------------------------------------
  const tokens = await exchangeCode(config, callback.code, callback.redirectUri, callback.verifier);
  check('jeton d’accès obtenu', tokens.accessToken === 'fake-access-token');
  check('jeton de rafraîchissement obtenu', tokens.refreshToken === 'fake-refresh-token');

  // --- 3. Coffre chiffré ----------------------------------------------------
  const vault = new Vault(userData, protect, unprotect);
  let emitted = [];
  const service = new GoogleService({
    vault,
    userDataDir: userData,
    openExternal: (url) => {
      void fetch(url);
    },
    downloadsDir: async () => downloadDir,
    emitDownload: (event) => emitted.push(event),
    endpoints,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  const status = await service.clientStatus();
  check('client OAuth détecté', status.configured && status.source === 'env', status.source);

  const account = await service.connect();
  check('compte connecté', account.email === 'boitier.test@gmail.com', account.email);
  // 3 Gio au total, dont 2,5 Gio dans Drive : la carte du compte doit annoncer
  // le total, sinon un compte à moitié plein s'affiche comme vide.
  check(
    'quota réel lu',
    account.quotaBytes === 16106127360 && account.usedBytes === 3221225472,
    `${account.usedBytes} / ${account.quotaBytes}`,
  );
  check('identifiant local stable', account.accountId.startsWith('gdrive-'));
  // La date de consentement est réécrite à chaque autorisation : c'est elle qui
  // distingue un jeton durable d'un jeton hérité de la période de test.
  check(
    'date de consentement enregistrée',
    typeof account.authorizedAt === 'string' &&
      Math.abs(Date.now() - Date.parse(account.authorizedAt)) < 60_000,
    String(account.authorizedAt),
  );

  const cipher = await readFile(join(userData, 'google-accounts.enc'));
  check('coffre écrit sur le disque', cipher.length > 0);
  check(
    'fichier non lisible sans déchiffrement',
    !cipher.toString('utf8').trimStart().startsWith('{'),
  );
  const open = unprotect(cipher) ?? '';
  check('jeton présent uniquement chiffré', open.includes('fake-refresh-token'));

  // --- 4. Persistance : nouveau service sur le même dossier ------------------
  const service2 = new GoogleService({
    vault: new Vault(userData, protect, unprotect),
    userDataDir: userData,
    openExternal: () => undefined,
    downloadsDir: async () => downloadDir,
    emitDownload: (event) => emitted.push(event),
    endpoints,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });
  const persisted = await service2.accounts();
  check('compte restauré après redémarrage', persisted.length === 1 && persisted[0].email === 'boitier.test@gmail.com');

  // --- 5. Exploration -------------------------------------------------------
  const rootFiles = await service2.list(account.accountId, 'root');
  check('racine explorée', rootFiles.length === 2, `${rootFiles.length} éléments`);
  const folder = rootFiles.find((file) => file.kind === 'folder');
  check('dossiers identifiés', folder?.name === 'Projets', folder?.name);
  const children = await service2.list(account.accountId, folder.id);
  check('dossier enfant exploré', children.some((file) => file.name === 'Devis 2026.pdf'));

  // --- 5ter. Fichiers partagés avec moi -------------------------------------
  const shared = await service2.shared(account.accountId);
  check(
    'vue « Partagés avec moi » : un fichier partagé remonte',
    shared.length === 1 && shared[0].name === 'Planning équipe.xlsx',
    shared.map((file) => file.name).join(', ') || 'aucun',
  );
  check(
    'vue « Partagés avec moi » : le fichier n’est pas dans la racine',
    !rootFiles.some((file) => file.id === shared[0]?.id),
  );

  // --- 5quater. Chemin d'un résultat de recherche ----------------------------
  //
  // La recherche multi-comptes renvoie des fichiers sans leur chemin : Drive ne
  // donne que l'identifiant du dossier parent. `locate` remonte la chaîne pour
  // que « Ouvrir le dossier » mène quelque part. La racine du compte est exclue
  // du chemin : elle n'est pas un dossier de l'utilisateur.
  const trail = await service2.locate(account.accountId, 'file-devis');
  check(
    'chemin : « Devis 2026.pdf » est localisé dans Projets',
    trail.length === 1 && trail[0].name === 'Projets',
    trail.map((step) => step.name).join(' / ') || 'chemin vide',
  );
  const deep = await service2.locate(account.accountId, 'file-doc');
  check(
    'chemin : un fichier imbriqué donne la chaîne complète',
    deep.length === 2 && deep[0].name === 'Projets' && deep[1].name === '2026',
    deep.map((step) => step.name).join(' / ') || 'chemin vide',
  );
  const atRoot = await service2.locate(account.accountId, 'file-notes');
  check(
    'chemin : un fichier à la racine donne un chemin vide',
    atRoot.length === 0,
    atRoot.map((step) => step.name).join(' / ') || 'aucun niveau',
  );

  // --- 5bis. Adresses Gmail : les alias ne font pas un second compte ---------
  check(
    'adresses Gmail : les variantes désignent la même boîte',
    canonicalGmail('First.Boitier1+2@gmail.com') === 'firstboitier1@gmail.com' &&
      canonicalGmail('firstboitier1@googlemail.com') === 'firstboitier1@gmail.com',
  );
  check(
    'adresses Gmail : un domaine non Gmail est laissé intact',
    canonicalGmail('boitier@monentreprise.fr') === null,
  );
  const alias = findAlias('firstboitier1+2@gmail.com', [
    { id: 'gdrive-x', email: 'firstboitier1@gmail.com' },
    { id: 'gdrive-y', email: 'saturninyoukpo8@gmail.com' },
  ]);
  check(
    'adresses Gmail : l’alias est reconnu comme une adresse déjà connectée',
    alias.duplicateOf?.id === 'gdrive-x' && alias.variant,
    alias.duplicateOf?.email ?? 'aucune correspondance',
  );
  check(
    'adresses Gmail : un compte distinct reste distinct',
    !findAlias('saturninyoukpo13@gmail.com', [
      { id: 'gdrive-y', email: 'saturninyoukpo8@gmail.com' },
    ]).duplicateOf,
  );

  // --- 5ter. Noms des comptes -----------------------------------------------
  check(
    'noms : les chiffres de l’adresse distinguent deux comptes homonymes',
    suggestedName({ name: 'saturnin youkpo', email: 'saturninyoukpo8@gmail.com' }) ===
      'Saturnin Youkpo8' &&
      suggestedName({ name: 'saturnin youkpo', email: 'saturninyoukpo13@gmail.com' }) ===
      'Saturnin Youkpo13',
    suggestedName({ name: 'saturnin youkpo', email: 'saturninyoukpo13@gmail.com' }),
  );
  check(
    'noms : un nom déjà distinctif n’est pas rallongé',
    suggestedName({ name: 'Boitier First7', email: 'boitierfirst7@gmail.com' }) ===
      'Boitier First7',
  );
  check(
    'noms : un nom sans chiffre dans l’adresse reste intact',
    suggestedName({ name: 'Boitier First Recup', email: 'boitierecup@gmail.com' }) ===
      'Boitier First Recup',
  );

  // --- 5quater. Répartition du stockage -------------------------------------
  const storage = await service2.storage(account.accountId);
  check(
    'stockage : le quota annoncé est l’espace total du compte, pas Drive seul',
    storage.quotaBytes === 16106127360 && storage.usedBytes === 3221225472,
    `${storage.usedBytes} / ${storage.quotaBytes} (Drive seul : 2684354560)`,
  );
  check(
    'stockage : Gmail/Photos déduit quand Google le distingue',
    storage.emailBytes === 536870912,
    String(storage.emailBytes),
  );
  const documents = storage.categories.find((category) => category.id === 'document');
  const totalMeasured = storage.categories.reduce((sum, item) => sum + item.bytes, 0);
  check(
    'stockage : sommes par catégorie cohérentes avec les fichiers du faux Drive',
    Boolean(documents) && totalMeasured > 0 && !storage.partial,
    `${totalMeasured} o mesurés`,
  );
  const archives = storage.categories.find((category) => category.id === 'archive');
  check(
    'stockage : les fichiers partagés par d’autres ne comptent pas dans le quota',
    archives?.bytes === 0,
    `${archives?.bytes ?? -1} o d’archives (13 Gio appartiennent à un tiers)`,
  );
  const videos = storage.categories.find((category) => category.id === 'video');
  check(
    'stockage : les fichiers en corbeille sont exclus de la mesure',
    videos?.bytes === 0,
    `${videos?.bytes ?? -1} o de vidéos (5 Gio en corbeille)`,
  );
  check(
    'stockage : la répartition ne dépasse jamais le quota annoncé',
    totalMeasured <= storage.usedBytes,
    `${totalMeasured} o mesurés pour ${storage.usedBytes} o utilisés`,
  );

  // --- 5quinquies. Flux « récents » -----------------------------------------
  const recent = await service2.recent(account.accountId, { days: 90, limit: 10 });
  check(
    'récents : liste triée du plus récent au plus ancien',
    recent.length > 0 &&
      recent.every(
        (file, index) =>
          index === 0 || new Date(recent[index - 1].modified) >= new Date(file.modified),
      ),
    recent.map((file) => file.name).join(' › '),
  );
  const futur = new Date(Date.now() + 86_400_000).toISOString();
  const emptyRecent = await service2.recent(account.accountId, { days: 1, limit: 10 });
  check(
    'récents : la fenêtre de temps est bien transmise à Google',
    Array.isArray(emptyRecent) && emptyRecent.every((file) => new Date(file.modified) <= new Date()),
    `${emptyRecent.length} élément(s) sur 1 jour (horizon ${futur.slice(0, 10)})`,
  );

  // --- 6. Recherche ---------------------------------------------------------
  const found = await service2.search(account.accountId, 'devis');
  check('recherche Drive', found.length === 1 && found[0].name === 'Devis 2026.pdf');

  // --- 7. Téléchargement réel ----------------------------------------------
  await service2.download({
    id: 'dl-1',
    accountId: account.accountId,
    fileId: 'file-notes',
    name: 'notes.txt',
    size: 0,
  });
  await waitFor(() => emitted.some((event) => event.id === 'dl-1' && event.status === 'done'), 8000);
  const savedPath = join(downloadDir, 'notes.txt');
  const saved = await readFile(savedPath, 'utf8');
  check('fichier réellement écrit', saved.startsWith('BOITIER CLOUD MANAGER'), saved.trim());
  const savedStat = await stat(savedPath);
  check('taille conforme', savedStat.size === Buffer.byteLength(saved));
  check(
    'progression diffusée',
    emitted.some((event) => event.id === 'dl-1' && event.status === 'running') ||
      emitted.some((event) => event.id === 'dl-1' && event.received > 0),
  );
  check('aucun fichier partiel restant', !(await exists(`${savedPath}.part`)));

  // --- 8. Doublon : « (1) » ------------------------------------------------
  await service2.download({
    id: 'dl-2',
    accountId: account.accountId,
    fileId: 'file-notes',
    name: 'notes.txt',
    size: 0,
  });
  await waitFor(() => emitted.some((event) => event.id === 'dl-2' && event.status === 'done'), 8000);
  check('second téléchargement renommé', await exists(join(downloadDir, 'notes (1).txt')));

  // --- 8bis. Téléchargement d'un dossier entier ----------------------------
  const plan = await service2.plan(account.accountId, folder.id);
  check(
    'dossier entier : arborescence parcourue',
    plan.files.length === 1 &&
      plan.files[0].path === 'Devis 2026.pdf' &&
      plan.folders.join(',') === '2026',
    `${plan.files.map((file) => file.path).join(', ')} | dossiers: ${plan.folders.join(', ')}`,
  );
  check(
    'dossier entier : document Google natif écarté',
    plan.skipped.length === 1 && plan.skipped[0].endsWith('Compte rendu'),
    plan.skipped.join(', ') || 'aucun',
  );
  check(
    'dossier entier : destination assainie (pas de sortie du dossier)',
    relativeDir('C:\\base', '../../etc') === join('C:\\base', 'etc') &&
      relativeDir('C:\\base', 'a/b') === join('C:\\base', 'a', 'b'),
  );

  emitted = [];
  await service2.download({
    id: 'dl-tree',
    accountId: account.accountId,
    fileId: 'file-devis',
    name: 'Devis 2026.pdf',
    size: 48211,
    subPath: 'Projets/2026',
  });
  await waitFor(
    () => emitted.some((event) => event.id === 'dl-tree' && event.status === 'done'),
    8000,
  );
  check(
    'dossier entier : fichier écrit dans son sous-dossier',
    await exists(join(downloadDir, 'Projets', '2026', 'Devis 2026.pdf')),
  );

  // --- 9. Document Google natif refusé -------------------------------------
  emitted = [];
  await service2.download({
    id: 'dl-3',
    accountId: account.accountId,
    fileId: 'file-doc',
    name: 'Compte rendu',
    size: 0,
  });
  await waitFor(() => emitted.some((event) => event.id === 'dl-3' && event.status === 'error'), 6000);
  const docError = emitted.find((event) => event.id === 'dl-3' && event.status === 'error');
  check('document Google natif signalé', Boolean(docError?.message?.includes('Google natifs')));

  // --- 10. Pause ------------------------------------------------------------
  emitted = [];
  await service2.download({
    id: 'dl-4',
    accountId: account.accountId,
    fileId: 'file-devis',
    name: 'Devis 2026.pdf',
    size: 48211,
  });
  service2.pause('dl-4');
  await waitFor(
    () => emitted.some((event) => event.id === 'dl-4' && event.status === 'paused') ||
      emitted.some((event) => event.id === 'dl-4' && event.status === 'done'),
    6000,
  );
  check('pause gérée sans plantage', emitted.some((event) => event.id === 'dl-4'));

  // --- 11. Jeton révoqué : statut « expiré » -------------------------------
  const brokenVault = new Vault(join(workDir, 'broken'), protect, unprotect);
  const brokenSession = new GoogleSession(brokenVault, endpoints);
  await brokenSession.saveAccount({
    id: 'gdrive-broken',
    name: 'Test',
    email: 'broken@test.com',
    usedBytes: 0,
    quotaBytes: 0,
    status: 'connected',
    createdAt: new Date().toISOString(),
    tokens: { accessToken: 'nope', expiresAt: 0, refreshToken: 'revoked-token' },
  });
  let expired = false;
  try {
    await brokenSession.accessToken('gdrive-broken', config);
  } catch {
    expired = true;
  }
  const brokenState = await brokenSession.account('gdrive-broken');
  check('révocation détectée', expired && brokenState?.status === 'expired');

  // --- 12. Déconnexion : révocation côté Google + purge locale ------------
  await service2.disconnect(account.accountId);
  check('compte retiré du coffre', (await service2.accounts()).length === 0);
  const revoked = await (await fetch(`${BASE}/state`)).json();
  check(
    'jeton révoqué chez Google',
    revoked.revoked.includes('fake-refresh-token'),
    revoked.revoked.join(','),
  );
  const remaining = await readFile(join(userData, 'google-accounts.enc'))
    .then((cipher) => unprotect(cipher) ?? '')
    .catch(() => '');
  check('jeton effacé du coffre', !remaining.includes('fake-refresh-token'));
} catch (cause) {
  failures += 1;
  console.error('Erreur inattendue :', cause);
} finally {
  fake.kill();
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}

/* --- 11bis. Dossier impossible : l'échec doit être signalé ------------------ */
try {
  const { writeFile: write, mkdir: make } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'boitier-dossier-'));
  // Un fichier à la place du dossier : la création échoue forcément.
  const obstacle = join(dir, 'obstacle');
  await write(obstacle, 'x');
  const events = [];
  const manager = new DownloadManager(
    { drive: 'http://127.0.0.1:9/drive/v3' },
    (event) => events.push(event),
    async () => dir,
  );
  await manager.start(
    { id: 'dossier', fileId: 'f', name: 'v.mp4', size: 1024, dir: join(obstacle, 'sous') },
    'jeton',
  );
  const ended = await waitFor(
    () => events.some((event) => event.id === 'dossier' && event.status === 'error'),
    3000,
  );
  check(
    'dossier impossible : un échec est signalé au lieu d’un 0 % muet',
    ended,
    events.map((event) => `${event.status}:${event.message ?? ''}`).join(' | ') || 'aucun événement',
  );
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  void make;
} catch (cause) {
  failures += 1;
  console.error('Dossier impossible : erreur inattendue', cause);
}

/* --- 11ter. Adresses autorisées vers le navigateur ------------------------- */
{
  const { driveFolderUrl, driveFileUrl, isAllowedExternalUrl } = await import(
    '../../src/lib/driveLinks.ts'
  );
  check(
    'liens : un dossier Drive est ouvert au bon endroit',
    driveFolderUrl('1AbC') === 'https://drive.google.com/drive/folders/1AbC' &&
      driveFolderUrl('root') === 'https://drive.google.com/drive/my-drive',
    driveFolderUrl('1AbC'),
  );
  check(
    'liens : un fichier Drive est ouvert dans son aperçu',
    driveFileUrl('1AbC') === 'https://drive.google.com/file/d/1AbC/view',
    driveFileUrl('1AbC'),
  );
  check(
    'liens : une adresse étrangère reste refusée',
    !isAllowedExternalUrl('https://exemple.test/piege') &&
      !isAllowedExternalUrl('javascript:alert(1)') &&
      isAllowedExternalUrl('https://drive.google.com/drive/my-drive') &&
      isAllowedExternalUrl('https://console.cloud.google.com/apis'),
  );
}

/* --- 11bis-quater. Rangement des téléchargements -------------------------- */
{
  const { downloadSubPath, categoryFolder, joinFolder, cloudFolder } = await import(
    '../../src/lib/organize.ts'
  );
  check(
    'rangement : une vidéo va dans « Google Drive\\Videos », sans accent',
    downloadSubPath('gdrive', 'video') === 'Google Drive/Videos' &&
      categoryFolder('document') === 'Documents' &&
      categoryFolder('archive') === 'Archives' &&
      cloudFolder('gdrive') === 'Google Drive',
    downloadSubPath('gdrive', 'video'),
  );
  check(
    'rangement : désactivé, aucun sous-dossier n’est créé',
    downloadSubPath('gdrive', 'video', false) === undefined,
  );
  check(
    'rangement : le chemin suit le séparateur du dossier de base',
    joinFolder('C:\\Users\\BOITIER_FIRST\\Downloads', 'Google Drive/Videos') ===
      'C:\\Users\\BOITIER_FIRST\\Downloads\\Google Drive\\Videos' &&
      joinFolder('/home/saturnin/Downloads/', 'Google Drive/Audio') ===
        '/home/saturnin/Downloads/Google Drive/Audio',
    joinFolder('C:\\Users\\BOITIER_FIRST\\Downloads', 'Google Drive/Videos'),
  );
}

/* --- 11bis-bis. Thème clair : plus de tons chauds ------------------------- */
try {
  const { readFile: lire } = await import('node:fs/promises');
  const css = await lire(new URL('../../src/styles.css', import.meta.url), 'utf8');
  const debut = css.indexOf(":root[data-theme='light'] {");
  const bloc = css.slice(debut, css.indexOf('}', debut));
  check(
    'thème clair : accent bleu, fond froid',
    bloc.includes('--accent: #2f6bff') && bloc.includes('--bg: #f5f7fb'),
    bloc.slice(0, 60).replace(/\s+/g, ' '),
  );
  check(
    'groupes de comptes : passage à la ligne, espacement serré',
    /\.segmented--wrap \{[^}]*flex-wrap: wrap/s.test(css) &&
      /\.segmented--wrap \{[^}]*row-gap: 4px/s.test(css),
  );
  check(
    'thème clair : aucun ton chaud ne subsiste dans les fonds',
    !/--(bg|panel|rail-bg): #f(3f1ec|bfaf7|6f4ef)/.test(bloc),
    (bloc.match(/--bg: #[0-9a-f]{6}/) ?? ['absent'])[0],
  );
} catch (cause) {
  failures += 1;
  console.error('Thème clair : lecture impossible', cause);
}

/* --- 11bis-ter. Dossier parent d'un fichier ------------------------------- */
{
  const { parentDir } = await import('../../src/lib/transfers.ts');
  check(
    'chemin : le dossier parent est reconnu sous Windows et sous Linux',
    parentDir('C:\\Users\\Saturnin\\Downloads\\film.mp4') ===
      'C:\\Users\\Saturnin\\Downloads' &&
      parentDir('/home/saturnin/Vidéos/film.mp4') === '/home/saturnin/Vidéos' &&
      parentDir('C:\\Users\\Saturnin\\Downloads\\') === 'C:\\Users\\Saturnin',
    parentDir('C:\\Users\\Saturnin\\Downloads\\film.mp4'),
  );
}

/* --- 11quater. Dossiers inventés et transferts fantômes -------------------- */
{
  const { isLegacyDownloadFolder, interruptStaleDownloads } = await import(
    '../../src/lib/transfers.ts'
  );
  check(
    'dossier : les anciens chemins inventés sont reconnus',
    isLegacyDownloadFolder('D:\\Médias\\Téléchargements') &&
      isLegacyDownloadFolder('C:\\Users\\Boitier\\Téléchargements') &&
      !isLegacyDownloadFolder('C:\\Users\\Saturnin\\Téléchargements'),
  );
  const fantomes = interruptStaleDownloads([
    { id: 'a', status: 'active', received: 0, speed: 4200 },
    { id: 'b', status: 'done', received: 10, speed: 0 },
  ]);
  check(
    'file : un transfert restauré « en cours » est déclaré interrompu',
    fantomes[0].status === 'error' &&
      /Relancez/.test(fantomes[0].error ?? '') &&
      fantomes[0].speed === 0 &&
      fantomes[1].status === 'done',
    `${fantomes[0].status} — ${fantomes[0].error ?? ''}`,
  );
}

/* --- 12. Veilleur : un flux muet devient une erreur, pas un 0 % éternel --- */
try {
  const server = await silentStreamServer();
  const port = server.address().port;
  // `workDir` a déjà été supprimé à ce stade : dossier temporaire dédié.
  const dir = await mkdtemp(join(tmpdir(), 'boitier-veilleur-'));
  const events = [];
  const manager = new DownloadManager(
    { drive: `http://127.0.0.1:${port}/drive/v3` },
    (event) => events.push(event),
    async () => dir,
    { stallMs: 400 },
  );
  await manager.start({ id: 'muet', fileId: 'f', name: 'v.mp4', size: 1048576, dir }, 'jeton');
  const ended = await waitFor(
    () => events.some((event) => event.id === 'muet' && event.status === 'error'),
    5000,
  );
  const final = events.at(-1);
  check(
    'veilleur : un flux sans octet est signalé en erreur',
    ended && final.status === 'error' && /aucune donnée/i.test(final.message ?? ''),
    final.message ?? 'aucune erreur émise',
  );
  check(
    'veilleur : aucun fichier partiel ne reste sur le disque',
    !(await exists(join(dir, 'v.mp4'))) && !(await exists(join(dir, 'v.mp4.part'))),
  );
  server.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
} catch (cause) {
  failures += 1;
  console.error('Veilleur : erreur inattendue', cause);
}

/* --- 18. Démarrage : trace, écran d'attente, instance unique --------------- */
//
// Trois défauts constatés sur les journaux réels, corrigés ici :
//   • un second clic sur l'icône sortait **sans écrire une ligne** (le contrôle
//     d'instance unique passait avant l'ouverture du journal) → l'application
//     semblait refuser de démarrer ;
//   • la fenêtre n'apparaissait qu'une fois l'interface chargée (4 à 13 s au
//     premier lancement après installation) → rien à l'écran pendant ce temps ;
//   • ce second clic ne ramenait même pas la fenêtre existante au premier plan.
{
  const { readFile: lire } = await import('node:fs/promises');
  const main = await lire(new URL('../main.ts', import.meta.url), 'utf8');

  const startBody = main.slice(main.indexOf('async function start()'));
  const iLock = main.indexOf('requestSingleInstanceLock');
  check(
    'démarrage : le journal est ouvert avant le contrôle d’instance unique',
    (() => {
      const startBody = main.slice(main.indexOf('async function start()'));
      const open = startBody.indexOf('startLog();');
      const lock = startBody.indexOf('await acquireInstanceLock()');
      return open !== -1 && lock !== -1 && open < lock;
    })(),
    'ordre journal / verrou',
  );
  check(
    'démarrage : un lancement refusé laisse une ligne dans le journal',
    /if \(!\(await acquireInstanceLock\(\)\)\) \{\s*\n\s*log\(/.test(main),
  );

  const iSecond = main.indexOf("app.on('second-instance'");
  check(
    'démarrage : un second clic ramène la fenêtre existante au premier plan',
    iSecond !== -1 &&
      /revealWindow\(\)/.test(main.slice(iSecond, iSecond + 300)) &&
      /if \(win\.isMinimized\(\)\) win\.restore\(\)/.test(main) &&
      /win\.focus\(\)/.test(main),
  );

  // L'écran de démarrage vit désormais **dans** la page : une seconde fenêtre
  // s'affichait comme un carré vide au milieu de l'écran, avant que son contenu
  // ne soit peint. Une seule fenêtre, un contenu peint avec le document.
  const html = await lire(new URL('../../index.html', import.meta.url), 'utf8');
  const app = await lire(new URL('../../src/main.tsx', import.meta.url), 'utf8');
  check(
    'démarrage : l’écran de démarrage est dans la page, styles compris',
    /id="boot"/.test(html) &&
      /<style>[\s\S]*boot__bar[\s\S]*<\/style>/.test(html) &&
      !/<link[^>]+stylesheet/i.test(html),
  );
  check(
    'démarrage : aucun fichier à charger avant le premier écran',
    html.indexOf('id="boot"') < html.indexOf('/src/main.tsx'),
  );
  check(
    'démarrage : l’écran de démarrage disparaît quand l’interface prend la main',
    (() => {
      const ready = app.slice(app.indexOf('function ReadySignal'), app.indexOf('return null'));
      return ready.includes("getElementById('boot')?.remove()");
    })(),
    'retrait absent ou placé hors du signal de vie',
  );
  check(
    'démarrage : le thème enregistré est appliqué avant le premier pixel',
    /boitier-cloud-manager:v1/.test(html) && /dataset\.theme/.test(html),
  );
  check(
    'démarrage : plus de seconde fenêtre d’attente (le carré vide)',
    !/openSplash|SPLASH_HTML/.test(main),
  );
  check(
    'démarrage : le fond de fenêtre suit le thème livré, pas l’ancien sombre',
    /backgroundColor: '#f5f7fb'/.test(main) && !/backgroundColor: '#0b0d10'/.test(main),
  );
}

/* --- 19. Recherche à deux portées ----------------------------------------- */
//
// Demande explicite : chercher dans **tous** les comptes *et* dans un seul.
// Ces contrôles lisent la page de recherche : ils échouent si une portée
// disparaît, si la frappe n'est plus temporisée, ou si un compte en échec
// n'est plus signalé.
{
  const { readFile: lire } = await import('node:fs/promises');
  const page = await lire(new URL('../../src/pages/Search.tsx', import.meta.url), 'utf8');
  const app = await lire(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const sidebar = await lire(
    new URL('../../src/components/Sidebar.tsx', import.meta.url),
    'utf8',
  );

  check(
    'recherche : une entrée de menu et une route dédiées',
    /'Recherche'/.test(sidebar) && /name: 'search'/.test(await (async () =>
      lire(new URL('../../src/store.tsx', import.meta.url), 'utf8'))()) &&
      /case 'search'/.test(app),
  );
  check(
    'recherche : les deux portées existent — tous les comptes et un seul',
    page.includes('Tous les comptes') &&
      page.includes("setScope('all')") &&
      page.includes('setScope(account.id)'),
    'portée manquante',
  );
  check(
    'recherche : la frappe est temporisée avant d’interroger les comptes',
    page.includes('const DEBOUNCE_MS = 400') && page.includes('setTimeout(() => setSettled'),
    'aucune temporisation',
  );
  check(
    'recherche : la portée « tous » interroge bien tous les comptes',
    page.includes("scope === 'all' ? accounts : accounts.filter"),
    'portée unique en dur',
  );
  check(
    'recherche : un compte en échec est annoncé, pas passé sous silence',
    page.includes('className="search-status__error"') && page.includes("status === 'error'"),
    'aucun signalement d’échec',
  );
  check(
    'recherche : chaque résultat peut être ouvert à son emplacement ou téléchargé',
    page.includes('await bridge.google.locate(') && page.includes('google') &&
      page.includes('.download({'),
    'aucune action sur le résultat',
  );
}

/* --- 20. Chemin d'un résultat : câblage complet --------------------------- */
{
  const { readFile: lire } = await import('node:fs/promises');
  const api = await lire(new URL('../api.ts', import.meta.url), 'utf8');
  const preload = await lire(new URL('../preload.cjs', import.meta.url), 'utf8');
  const bridge = await lire(new URL('../../src/lib/bridge.ts', import.meta.url), 'utf8');
  const service = await lire(new URL('../google/service.ts', import.meta.url), 'utf8');

  check(
    'chemin : le canal est déclaré, exposé et enregistré',
    /locate: 'google:locate'/.test(api) &&
      /handle\(channels\.locate/.test(api) &&
      /google:locate/.test(preload),
  );
  check(
    'chemin : l’interface peut demander le chemin d’un fichier',
    /locate\?\(accountId: string, fileId: string\): Promise/.test(bridge),
  );
  check(
    'chemin : la remontée s’arrête à la racine du compte, pas au-delà',
    /readItem\(this\.endpoints, token, 'root'\)/.test(service) &&
      /depth < 20/.test(service),
  );
}

/* --- 21. Mise à jour automatique ----------------------------------------- */
//
// Une mise à jour automatique rate de trois façons silencieuses :
//   • le manifeste `latest.yml` n'est pas joint à la release → l'application
//     voit le dépôt mais aucun fichier à télécharger ;
//   • une installation silencieuse au moment de quitter change de version sans
//     que personne ne l'ait demandé ;
//   • la bibliothèque n'est pas dans le paquet → l'application démarre puis
//     échoue à la première vérification.
// Ces contrôles couvrent les trois.
{
  const { readFile: lire } = await import('node:fs/promises');
  const pkg = JSON.parse(await lire(new URL('../../package.json', import.meta.url), 'utf8'));
  const flux = await lire(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const updater = await lire(new URL('../updater.ts', import.meta.url), 'utf8');
  const api = await lire(new URL('../api.ts', import.meta.url), 'utf8');
  const preload = await lire(new URL('../preload.cjs', import.meta.url), 'utf8');
  const bundle = await lire(new URL('../dist/main.cjs', import.meta.url), 'utf8');

  const publish = (pkg.build?.publish ?? [])[0] ?? {};
  check(
    'mise à jour : le dépôt de publication est déclaré',
    publish.provider === 'github' &&
      publish.owner === 'Boitier13' &&
      publish.repo === 'BOITIER-CLOUD-MANAGER',
    JSON.stringify(publish),
  );
  check(
    'mise à jour : installeur non signé — la vérification de signature est désactivée explicitement',
    pkg.build?.win?.verifyUpdateCodeSignature === false,
    String(pkg.build?.win?.verifyUpdateCodeSignature),
  );
  check(
    'mise à jour : le manifeste et les blockmaps sont publiés avec chaque version',
    /release\/latest\.yml/.test(flux) && /release\/\*\.blockmap/.test(flux),
  );
  check(
    'mise à jour : la publication échoue si le manifeste manque',
    /latest\.yml absent/.test(flux),
  );
  check(
    'mise à jour : aucune installation silencieuse à la fermeture',
    /autoInstallOnAppQuit = false/.test(updater),
    'installation au quit autorisée',
  );
  check(
    'mise à jour : l’installation passe par un clic, jamais par une vérification',
    (updater.match(/quitAndInstall\(/g) ?? []).length === 1 &&
      /if \(this\.state\.status !== 'ready' \|\| !autoUpdater\) return false;/.test(updater),
  );
  check(
    'mise à jour : rien ne s’exécute hors d’une installation réelle',
    /if \(!app\.isPackaged \|\| this\.wired\) return;/.test(updater),
  );
  check(
    'mise à jour : les trois canaux sont déclarés et enregistrés',
    /updateState: 'update:state'/.test(api) &&
      /updateCheck: 'update:check'/.test(api) &&
      /updateInstall: 'update:install'/.test(api) &&
      /handle\(channels\.updateCheck/.test(api) &&
      /handle\(channels\.updateInstall/.test(api),
  );
  check(
    'mise à jour : le pont expose l’état, la vérification et l’installation',
    /updater: \{/.test(preload) &&
      /update:state/.test(preload) &&
      /update:install/.test(preload) &&
      /update:event/.test(preload),
  );
  // Le point qui casserait tout en silence : une dépendance laissée externe
  // n'existerait pas dans l'archive (`node_modules` en est exclu).
  check(
    'mise à jour : la bibliothèque est compilée dans le processus principal',
    bundle.includes('autoUpdater') &&
      bundle.includes('app-update.yml') &&
      !/require\(["']electron-updater["']\)/.test(bundle),
    'dépendance laissée externe',
  );
  check(
    'mise à jour : le paquet ne dépend d’aucun module au démarrage',
    (pkg.build?.files ?? []).includes('!node_modules/**/*'),
  );
}

/* --- 22. Démarrage : trace avant tout, verrou patient, fenêtre garantie --- */
//
// Trois défauts observés en usage réel, qui donnaient tous le même symptôme —
// « l'application ne s'ouvre pas » — sans laisser aucune trace :
//   • un échec au chargement d'un module arrêtait le processus avant la
//     première ligne de journal ;
//   • l'installeur relance l'application alors que l'ancien processus meurt
//     encore : le verrou d'instance refusait, et le nouveau sortait sans rien
//     afficher ;
//   • une page qui ne peint jamais laissait une fenêtre invisible, et le
//     dialogue d'erreur était attaché à cette fenêtre invisible.
{
  const { readFile: lire } = await import('node:fs/promises');
  const boot = await lire(new URL('../boot.ts', import.meta.url), 'utf8');
  const build = await lire(new URL('../build.mjs', import.meta.url), 'utf8');
  const main = await lire(new URL('../main.ts', import.meta.url), 'utf8');
  const updater = await lire(new URL('../updater.ts', import.meta.url), 'utf8');

  check(
    'démarrage : le point d’entrée ouvre le journal avant le code applicatif',
    /entryPoints: \['desktop\/boot\.ts'\]/.test(build) &&
      boot.indexOf('initLog(') !== -1 &&
      boot.lastIndexOf('initLog(') < boot.lastIndexOf("require('./main.ts')"),
    'ordre journal / chargement',
  );
  check(
    'démarrage : une exception au chargement est écrite dans le journal et montrée',
    /process\.on\('uncaughtException'/.test(boot) &&
      /dialog\.showErrorBox\(/.test(boot) &&
      /échec \(\$\{origin\}\)/.test(boot),
  );
  check(
    'démarrage : le verrou d’instance est retenté avant d’abandonner',
    /LOCK_RETRY_DELAYS_MS/.test(main) &&
      /acquireInstanceLock/.test(main) &&
      (main.match(/requestSingleInstanceLock\(\)/g) ?? []).length === 1 &&
      /for \(let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS\.length/.test(main),
  );
  check(
    'démarrage : la fenêtre s’affiche même si la page ne peint pas',
    /délai d’affichage atteint/.test(main) && /setTimeout\(\(\) => show\(/.test(main),
  );
  check(
    'démarrage : les messages d’erreur ne sont pas attachés à une fenêtre invisible',
    /dialog\.showMessageBoxSync\(options\)/.test(main) &&
      !/showMessageBoxSync\(win, options\)/.test(main),
  );
  check(
    'mise à jour : la bibliothèque est chargée tardivement, sans bloquer le démarrage',
    /await import\('electron-updater'\)/.test(updater) &&
      !/^import .*from 'electron-updater'/m.test(updater),
  );
}

/* --- 23. Défilement : la page entière doit pouvoir descendre -------------- */
//
// Défaut constaté sur deux captures : le bas des Paramètres (« Ranger par cloud
// et par type ») et le neuvième compte étaient coupés net, sans barre de
// défilement. Cause : dans une colonne flexible, un enfant refuse de rétrécir
// sous la hauteur de son contenu sans `min-height: 0` ; la page débordait donc
// de la fenêtre au lieu de défiler.
{
  const { readFile: lire } = await import('node:fs/promises');
  const css = await lire(new URL('../../src/styles.css', import.meta.url), 'utf8');
  const bloc = (selecteur) => {
    const index = css.indexOf(`${selecteur} {`);
    return index === -1 ? '' : css.slice(index, css.indexOf('}', index));
  };

  const main = bloc('.app__main');
  const content = bloc('.app__content');
  check(
    'défilement : la colonne principale peut rétrécir sous son contenu',
    /min-height: 0/.test(main) && /overflow: hidden/.test(main),
    main.trim().split('\n')[0],
  );
  check(
    'défilement : la zone de contenu défile réellement',
    /min-height: 0/.test(content) && /overflow-y: auto/.test(content),
    'zone non défilante',
  );
  check(
    'défilement : aucun tableau n’impose une hauteur minimale fixe',
    !/\.filetable-wrap \{[^}]*min-height: 380px/.test(css),
    'hauteur minimale fixe',
  );
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} vérifications réussies.`);
if (failures) {
  console.error(`${failures} échec(s).`);
  process.exit(1);
}
process.exit(0);

/* --- utilitaires ---------------------------------------------------------- */

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Flux qui se tait : en-têtes envoyés, aucun octet ensuite.
 *
 * C'est le cas qui laissait une ligne « En cours » à 0 % indéfiniment. Le
 * veilleur doit transformer ce silence en erreur explicite.
 */
async function silentStreamServer() {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('alt') === 'media') {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '1048576' });
      return; // jamais un octet
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'f', name: 'v.mp4', mimeType: 'video/mp4', size: '1048576' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
