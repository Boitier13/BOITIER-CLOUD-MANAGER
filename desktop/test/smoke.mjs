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
  const { downloadSubPath, categoryFolder, cloudFolder } = await import(
    '../../src/lib/organize.ts'
  );
  const { joinFolder } = await import('../../src/lib/downloadFolder.ts');
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

/* --- 11bis-quinquies. Un seul dossier pour tous les téléchargements ------- */
//
// Les fichiers tombaient directement dans « Téléchargements », mêlés aux
// vidéos personnelles et aux archives du bureau : impossible de retrouver ce
// qui vient des clouds. Tout est désormais écrit sous
// `Téléchargements\\BOITIER-CLOUD-MANAGER\\<cloud>\\<nature>`.
{
  const { APP_DOWNLOAD_FOLDER, defaultDownloadDir, joinFolder: joinFolderPath } = await import(
    '../../src/lib/downloadFolder.ts'
  );
  check(
    'téléchargements : le dossier commun porte le nom de l’application',
    APP_DOWNLOAD_FOLDER === 'BOITIER-CLOUD-MANAGER',
    APP_DOWNLOAD_FOLDER,
  );
  check(
    'téléchargements : le chemin par défaut se place sous le dossier commun',
    defaultDownloadDir('C:\\Users\\BOITIER_FIRST\\Downloads') ===
      'C:\\Users\\BOITIER_FIRST\\Downloads\\BOITIER-CLOUD-MANAGER' &&
      defaultDownloadDir('/home/saturnin/Downloads/') ===
        '/home/saturnin/Downloads/BOITIER-CLOUD-MANAGER',
    defaultDownloadDir('C:\\Users\\BOITIER_FIRST\\Downloads'),
  );
  check(
    'téléchargements : le module est autonome (lisible par le processus principal)',
    joinFolderPath('C:\\a', 'b') === 'C:\\a\\b' && joinFolderPath('/a', 'b') === '/a/b',
    joinFolderPath('C:\\a', 'b'),
  );

  const racineSmoke = new URL('../../', import.meta.url);
  const lire = (chemin) => readFile(new URL(chemin, racineSmoke), 'utf8');
  const sourceMain = await lire('desktop/main.ts');
  check(
    'téléchargements : Google et MEGA écrivent dans le dossier commun',
    /downloadsDir: async \(\) => defaultDownloadDir\(app\.getPath\('downloads'\)\)/.test(
      sourceMain,
    ) &&
      /fallbackDir: async \(\) => defaultDownloadDir\(app\.getPath\('downloads'\)\)/.test(
        sourceMain,
      ),
    'un des deux chemins écrit encore à la racine de Téléchargements',
  );
  check(
    'téléchargements : aucun dossier système brut ne sert de destination',
    !/dir: app\.getPath\('downloads'\)|= app\.getPath\('downloads'\);/.test(sourceMain),
    'chemin brut encore présent',
  );

  // Les deux fournisseurs passent par le même sous-chemin : c'est ce qui range
  // un fichier sous `<cloud>\\<nature>`, quel que soit le cloud.
  const sourceGoogle = await lire('desktop/google/downloads.ts');
  const sourceMega = await lire('desktop/mega/service.ts');
  check(
    'téléchargements : Google Drive et MEGA partagent le même rangement',
    /relativeDir\(request\.dir \|\| \(await this\.fallbackDir\(\)\), request\.subPath\)/.test(
      sourceGoogle,
    ) &&
      /relativeDir\(request\.dir \|\| \(await (this\.)?fallbackDir\(\)\), request\.subPath\)/.test(
        sourceMega,
      ),
    'un fournisseur range autrement',
  );
}

/* --- 11bis-sexies. Les clouds portent leur vrai logo --------------------- */
//
// Un « G » et un « M » dans deux carrés de couleur se ressemblaient trop : la
// reconnaissance du fournisseur passait par la seule teinte du cadre.
{
  const sourceVisuals = await readFile(
    new URL('../../src/components/visuals.tsx', import.meta.url),
    'utf8',
  );
  check(
    'logos : la pastille ne fabrique plus d’initiale',
    !/name\.charAt\(0\)|charAt\(0\)\.toUpperCase\(\)/.test(sourceVisuals) &&
      !/def\.id === 'gdrive' \? 'G'/.test(sourceVisuals),
    'initiale encore présente',
  );
  check(
    'logos : chaque fournisseur connu a son dessin',
    (sourceVisuals.match(/<svg/g) ?? []).length >= 2 &&
      /#d9272e/.test(sourceVisuals) &&
      /#34a853/.test(sourceVisuals) &&
      /#fbbc04/.test(sourceVisuals) &&
      /#4285f4/.test(sourceVisuals),
    'dessin manquant',
  );
  check(
    'logos : un fournisseur non dessiné reçoit un nuage, pas une lettre',
    /un fournisseur pas encore dessiné|reçoit un nuage/i.test(sourceVisuals) ||
      /stroke="currentColor"/.test(sourceVisuals),
    'repli muet',
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
    'veilleur : aucun fichier complet n’est présenté après un échec',
    !(await exists(join(dir, 'v.mp4'))),
  );
  // Le partiel est **conservé** après un échec : la reprise s'appuie dessus.
  // Il ne disparaît qu'à l'annulation ou après un transfert réussi.
  // Rien n'est jeté : ce qui est sur le disque correspond exactement à ce qui
  // a été reçu (ici 0 octet — un flux muet n'a rien livré). La section 26
  // vérifie le cas où des octets existent réellement.
  const surDisque = await stat(join(dir, 'v.mp4.part')).then((info) => info.size).catch(() => 0);
  check(
    'veilleur : aucun octet reçu n’est jeté (base de reprise intacte)',
    surDisque === (final.received ?? 0),
    `${surDisque} o sur le disque pour ${final.received ?? 0} o reçus`,
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
  const principal = await lire(new URL('../main.ts', import.meta.url), 'utf8');

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
      /if \(this\.state\.status !== 'ready' \|\| !autoUpdater\) \{/.test(updater),
  );
  check(
    'mise à jour : le clic d’installation laisse une trace',
    /log\(`mise à jour : installation demandée/.test(updater) &&
      updater.indexOf('installation demandée') < updater.indexOf('quitAndInstall('),
    'aucune trace du clic',
  );
  check(
    'mise à jour : un installeur qui refuse de partir est signalé',
    /catch \(cause\) \{\s*log\(`mise à jour : installeur impossible/.test(updater) &&
      /message: 'L’installeur n’a pas pu être lancé/.test(updater),
    'échec silencieux',
  );
  check(
    'mise à jour : le planning des vérifications est journalisé',
    /log\(`mise à jour : première vérification dans/.test(updater),
    'planning absent du journal',
  );
  check(
    'mise à jour : rien ne s’exécute hors d’une installation réelle',
    /if \(!app\.isPackaged \|\| this\.wired\) return;/.test(updater),
  );
  // Journal d'un essai réel : chaque vérification était écrite deux fois (notre
  // `check()` et l'événement de la bibliothèque), et la progression à chaque
  // paquet. Une ligne par état réellement différent.
  check(
    'mise à jour : une seule ligne de journal par état réel',
    /export function traceMiseAJour/.test(updater) &&
      /if \(trace !== derniereTrace\) \{/.test(principal) &&
      /import \{ traceMiseAJour, Updater \} from '\.\/updater\.ts';/.test(principal),
    'doublons possibles',
  );
  check(
    'mise à jour : la progression est journalisée par paliers de 10 %',
    /Math\.floor\(borne \/ 10\) \* 10/.test(updater),
    'journal de progression à chaque paquet',
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
  const logSource = await lire(new URL('../log.ts', import.meta.url), 'utf8');

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
    'démarrage : chaque étape porte son temps depuis le lancement',
    /export function sinceStart\(\): number/.test(logSource ?? '') &&
      (main.match(/\+\$\{sinceStart\(\)\} ms/g) ?? []).length >= 4,
    'temps absent des étapes',
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

/* --- 24. File de téléchargements : un tick sans travail ne réveille rien ---- */
//
// Défaut signalé : « l'application se fige beaucoup, elle est devenue
// instable ». Cause trouvée en lisant l'état : `advanceDownloads` construisait
// un tableau neuf à chaque appel, toutes les 900 ms, même quand rien n'avançait.
// Un nouvel état global → toute l'interface repeinte et le stockage réécrit,
// indéfiniment, dès qu'un seul transfert (même terminé) restait dans la liste.
{
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // `fileURLToPath` et non `.pathname` : sous Windows, `.pathname` donne
  // « /C:/… », qu'aucun outil ne sait ouvrir. C'est ce qui a fait échouer la
  // publication de la 0.22.6 alors que tout passait sous Linux.
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const racine = fileURLToPath(new URL('../..', import.meta.url));
  const { build } = await import('esbuild');

  const sortie = join(tmpdir(), `boitier-downloads-${process.pid}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/lib/downloads.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: sortie,
    logLevel: 'silent',
  });
  const { advanceDownloads } = await import(pathToFileURL(sortie).href);

  const transfert = (extra = {}) => ({
    id: 't1',
    name: 'Conference.mp4',
    type: 'video',
    size: 1000,
    received: 1000,
    speed: 0,
    baseSpeed: 0,
    status: 'done',
    provider: 'gdrive',
    accountId: 'g-1',
    accountName: 'Boitier',
    path: [],
    addedAt: '2026-11-01T00:00:00.000Z',
    ...extra,
  });

  const termine = [transfert()];
  check(
    'file : un tick sans travail rend le même tableau',
    advanceDownloads(termine, 3, 900) === termine,
  );

  const reel = [transfert({ status: 'active', remoteId: 'r1', received: 10 })];
  check(
    'file : un transfert réel en cours ne provoque aucun nouvel état',
    advanceDownloads(reel, 3, 900) === reel,
  );

  const simule = [transfert({ status: 'active', received: 0, baseSpeed: 1000 })];
  const avance = advanceDownloads(simule, 3, 900);
  check(
    'file : un transfert simulé avance réellement',
    avance !== simule && avance[0].received > 0,
    `${avance[0]?.received ?? '?'} o`,
  );

  const attente = [transfert({ status: 'queued', received: 0 })];
  const demarre = advanceDownloads(attente, 3, 900);
  check(
    'file : un transfert en attente démarre',
    demarre !== attente && demarre[0].status === 'active',
    demarre[0]?.status ?? '?',
  );
}

/* --- 25. Le figement laisse une trace, et rien ne le provoque -------------- */
{
  const { readFile: lire } = await import('node:fs/promises');
  const store = await lire(new URL('../../src/store.tsx', import.meta.url), 'utf8');
  const app = await lire(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const api = await lire(new URL('../api.ts', import.meta.url), 'utf8');
  const preload = await lire(new URL('../preload.cjs', import.meta.url), 'utf8');
  const principal = await lire(new URL('../main.ts', import.meta.url), 'utf8');
  const parametres = await lire(
    new URL('../../src/pages/Settings.tsx', import.meta.url),
    'utf8',
  );

  check(
    'figement : le minuteur de file ne tourne que s’il y a du travail',
    /if \(!fileAnimee\) return;/.test(store) &&
      /item\.status === 'queued' \|\| \(item\.status === 'active' && !item\.remoteId\)/.test(
        store,
      ),
    'minuteur permanent',
  );
  check(
    'figement : la progression n’écrit pas le stockage à chaque point',
    /const fileStructure = state\.downloads\.map/.test(store) &&
      /\n    fileStructure,/.test(store),
    'écriture à chaque point de progression',
  );
  const sentinelle = await lire(
    new URL('../../src/hooks/useFreezeWatchdog.ts', import.meta.url),
    'utf8',
  );
  check(
    'figement : un blocage de l’interface est journalisé',
    /useFreezeWatchdog\(state\.route\.name\)/.test(app) &&
      /freeze: 'desktop:freeze'/.test(api) &&
      /figement \$\{\(perdu \/ 1000\)\.toFixed\(1\)\} s/.test(api) &&
      /reportFreeze: \(retard, contexte\) => ipcRenderer\.send\('desktop:freeze'/.test(preload),
    'aucune trace du blocage',
  );
  check(
    'figement : les tâches longues sont mesurées, pas seulement les gros gels',
    /new PerformanceObserver/.test(sentinelle) &&
      /entryTypes: \['longtask'\]/.test(sentinelle) &&
      /SEUIL_TACHE_MS = 250/.test(sentinelle),
    'blocages courts invisibles',
  );
  check(
    'figement : la lenteur du processus principal est distinguée de celle de l’interface',
    /ping: 'desktop:ping'/.test(api) &&
      /handle\(channels\.ping, \(\) => true\)/.test(api) &&
      /ping: \(\) => invoke\('desktop:ping'\)/.test(preload) &&
      /processus principal/.test(sentinelle),
    'origine du blocage inconnue',
  );
  check(
    'figement : le journal s’ouvre depuis les paramètres',
    /openLog: 'desktop:open-log'/.test(api) &&
      /shell\.openPath\(chemin\)/.test(api) &&
      /openLog: \(\) => invoke\('desktop:open-log'\)/.test(preload) &&
      /ouvrirJournal/.test(parametres),
    'journal inaccessible sans chercher le chemin',
  );
  check(
    'figement : les événements de mise à jour sont limités pour l’interface',
    /maintenant - dernierEnvoi < 250/.test(principal),
    'un événement par paquet',
  );
}

/* --- 28. Démarrage : la fenêtre montre l'écran de démarrage tout de suite - */
//
// Constat : `fenêtre créée +378 ms`, `affichée +3483 ms`, `document chargé
// +4460 ms`. La fenêtre restait donc invisible plus de trois secondes alors que
// l'écran de démarrage est du HTML avec ses styles en ligne, peint sans
// attendre le moindre fichier. On ne l'attend plus : on montre la fenêtre dès
// que le document est prêt, et chaque étape laisse un repère daté.
{
  const { readFile: lire } = await import('node:fs/promises');
  const principal = await lire(new URL('../main.ts', import.meta.url), 'utf8');
  const page = await lire(new URL('../../index.html', import.meta.url), 'utf8');
  const preload = await lire(new URL('../preload.cjs', import.meta.url), 'utf8');
  const api = await lire(new URL('../api.ts', import.meta.url), 'utf8');
  const interface_ = await lire(new URL('../../src/main.tsx', import.meta.url), 'utf8');

  check(
    'démarrage : la fenêtre s’affiche dès le document prêt',
    /on\('dom-ready'/.test(principal) &&
      /show\('écran de démarrage'\)/.test(principal),
    'affichage après le rendu complet de l’interface',
  );
  check(
    'démarrage : l’écran de démarrage ne dépend d’aucun fichier',
    /<style>[\s\S]*?<\/style>/.test(page.slice(0, page.indexOf('</head>'))) &&
      /id="boot"/.test(page),
    'écran de démarrage stylé par une feuille externe',
  );
  check(
    'démarrage : chaque étape laisse un repère daté',
    /document prêt · \+\$\{sinceStart\(\)\} ms/.test(principal) &&
      /chargement demandé · \+/.test(principal) &&
      /interface : \$\{texte\} · \+\$\{sinceStart\(\)\} ms/.test(api) &&
      /reportTiming: \(libelle\) => ipcRenderer\.send\('desktop:timing'/.test(preload),
    'étapes du démarrage invisibles',
  );
  check(
    'démarrage : l’interface mesure ce qu’elle voit',
    /bundle exécuté/.test(interface_) &&
      /premier rendu/.test(interface_) &&
      /polices prêtes/.test(interface_) &&
      /first-paint/.test(interface_),
    'aucune mesure côté interface',
  );
}

/* --- 27. Fin de transfert : une notification, jamais une bulle parasite -- */
{
  const { readFile: lire } = await import('node:fs/promises');
  const principal = await lire(new URL('../main.ts', import.meta.url), 'utf8');
  const emissions = principal.slice(principal.indexOf('emitDownload: (event) =>'));
  const corps = emissions.slice(0, emissions.indexOf('endpoints:'));

  check(
    'notification : Windows est prévenu en fin de transfert',
    /import \{[^}]*Notification[^}]*\} from 'electron'/.test(principal) &&
      /new Notification\(\{/.test(principal) &&
      /Notification\.isSupported\(\)/.test(principal),
    'aucune notification système',
  );
  check(
    'notification : seulement pour un transfert terminé ou échoué',
    /status === 'done' \|\| event\.status === 'error'/.test(principal) &&
      /notifierTransfert\(event\)/.test(corps),
    'bulle à chaque point de progression',
  );
  // Défaut réellement constaté : deux téléchargements terminés, aucune bulle.
  // La cause était la condition « seulement si la fenêtre n'a pas le focus » —
  // un transfert de plusieurs minutes se termine rarement sous les yeux de
  // l'utilisateur, et l'écran des téléchargements reste ouvert pendant ce temps.
  check(
    'notification : aucun silence lié au premier plan',
    !/isFocused\(\)\)\s*return;/.test(principal) &&
      /bulles\.add\(bulle\)/.test(principal),
    'bulle supprimée quand la fenêtre est au premier plan',
  );
  check(
    'notification : Windows sait à quelle application la rattacher',
    /app\.setAppUserModelId\('com\.boitier\.cloudmanager'\)/.test(principal) &&
      /"appId": "com\.boitier\.cloudmanager"/.test(await lire(new URL('../../package.json', import.meta.url), 'utf8')),
    'identifiant d’application absent : bulle ignorée sans erreur',
  );
  check(
    'notification : le clic ramène l’application',
    /bulle\.on\('click'/.test(principal) && /win\.focus\(\)/.test(principal),
    'bulle sans effet au clic',
  );
}

/* --- 29. MEGA : session, lecture, transferts ----------------------------- */
//
// MEGA n'a pas d'OAuth : sans précaution, la seule façon de retrouver un compte
// au lancement serait d'écrire le mot de passe sur le disque. On vérifie ici
// trois choses : le mot de passe n'est jamais conservé, la session chiffrée
// survit à un aller-retour, et les nœuds MEGA arrivent dans l'interface sous la
// même forme que ceux de Drive — sinon l'explorateur ne saurait rien afficher.
{
  const { MegaVault } = await import('../mega/store.ts');
  const fichiers = await import('../mega/files.ts');

  // Coffre : chiffrement factice (aller-retour) pour vérifier l'écriture.
  const dossier = await mkdtemp(join(tmpdir(), 'boitier-mega-'));
  const vault = new MegaVault(
    dossier,
    (clair) => Buffer.from(`scelle:${clair}`, 'utf8'),
    (chiffre) => {
      const texte = chiffre.toString('utf8');
      return texte.startsWith('scelle:') ? texte.slice('scelle:'.length) : null;
    },
  );
  await vault.write([
    {
      id: 'u1',
      email: 'compte@exemple.com',
      name: 'Compte',
      session: { key: 'cle', sid: 'session', name: 'Compte', user: 'u1' },
      addedAt: new Date().toISOString(),
    },
  ]);
  const surDisque = await readFile(join(dossier, 'mega-sessions.enc'), 'utf8');
  const relus = await vault.read();
  check(
    'MEGA : la session survit à un aller-retour sur le disque',
    relus.length === 1 && relus[0].session.sid === 'session' && relus[0].email === 'compte@exemple.com',
    `${relus.length} compte(s) relu(s)`,
  );
  check(
    'MEGA : le fichier de sessions est chiffré, pas lisible en clair',
    !surDisque.includes('compte@exemple.com') || surDisque.startsWith('scelle:'),
    'adresse en clair sur le disque',
  );

  // Le mot de passe ne doit apparaître nulle part dans le code de session :
  // seule la session sérialisée est écrite.
  const { fileURLToPath } = await import('node:url');
  const session = await readFile(fileURLToPath(new URL('../mega/session.ts', import.meta.url)), 'utf8');
  check(
    'MEGA : le mot de passe n’est jamais enregistré',
    // Ce qui part dans le coffre est explicitement reconstruit : clé, session,
    // nom et identifiant. Tout le reste — dont les identifiants de connexion —
    // est écarté.
    /const session = \{ key: json\.key, sid: json\.sid, name: nom, user: id \};/.test(session) &&
      !/session:\s*\{[^}]*password/i.test(session) &&
      !/password[^\n]*vault\.write/.test(session),
    'identifiants écrits dans la session',
  );

  // Conversion d'un nœud MEGA vers la forme commune aux deux fournisseurs.
  const nœud = fichiers.toRemoteFile({
    nodeId: 'n1',
    name: 'Film.mkv',
    size: 1024,
    directory: false,
    timestamp: 1_760_000_000,
  });
  check(
    'MEGA : un fichier arrive dans la même forme que chez Drive',
    nœud.kind === 'file' &&
      nœud.id === 'n1' &&
      nœud.mimeType === 'video/x-matroska' &&
      nœud.size === 1024 &&
      nœud.modified.startsWith('20'),
    `${nœud.kind} ${nœud.mimeType}`,
  );
  const tri = fichiers.sortRemoteFiles([
    fichiers.toRemoteFile({ nodeId: 'b', name: 'zèbre.txt', directory: false }),
    fichiers.toRemoteFile({ nodeId: 'a', name: 'Dossier', directory: true }),
  ]);
  check('MEGA : les dossiers passent devant, accents ignorés', tri[0].id === 'a', tri.map((f) => f.name).join(', '));

  // Erreurs : l'utilisateur doit lire une phrase, jamais un code négatif.
  check(
    'MEGA : les quotas de transfert sont expliqués',
    /quota de transfert/.test(fichiers.messageErreurMega({ code: -17 })) &&
      /deux étapes/.test(fichiers.messageErreurMega({ code: -26 })) &&
      /expirée/.test(fichiers.messageErreurMega({ code: -15 })),
    fichiers.messageErreurMega({ code: -17 }),
  );
  check(
    'MEGA : la vérification en deux étapes est reconnue',
    fichiers.exigeDeuxEtapes({ code: -26 }) &&
      !fichiers.exigeDeuxEtapes({ code: -17 }) &&
      fichiers.sessionExpiree({ code: -15 }),
    'code -26 non reconnu',
  );

  await rm(dossier, { recursive: true, force: true }).catch(() => undefined);
}

/* --- 31. Les comptes ne doivent jamais disparaître ----------------------- */
//
// Incident réel : après la connexion de 11 comptes MEGA, la liste des comptes
// Google est tombée de 9 à 2. Trois défauts pouvaient produire ce genre de
// perte ; les trois sont désormais interdits et vérifiés ici.
{
  const fichier = await mkdtemp(join(tmpdir(), 'boitier-comptes-'));

  // 1. La synchronisation Google ne touche qu'aux comptes Google.
  const { build } = await import('esbuild');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const sortie = join(fichier, 'accountSync.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/lib/accountSync.ts', import.meta.url))],
    outfile: sortie,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
  });
  const { mergeSyncedAccounts, normalizeAccounts } = await import(pathToFileURL(sortie).href);

  const google = (id, email) => ({
    id: `gdrive-real-${id}`,
    provider: 'gdrive',
    name: email.split('@')[0],
    email,
    status: 'connected',
    usedBytes: 1,
    quotaBytes: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    seed: 7,
    source: 'google',
    googleId: id,
    localTree: false,
  });
  const mega = (id) => ({
    id: `mega-real-${id}`,
    provider: 'mega',
    name: `mega-${id}`,
    email: `${id}@exemple.com`,
    status: 'connected',
    usedBytes: 1,
    quotaBytes: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    seed: 11,
    source: 'mega',
    megaId: id,
    localTree: false,
  });

  const avant = [google('g1', 'un@gmail.com'), google('g2', 'deux@gmail.com'), mega('m1'), mega('m2')];
  const apres = mergeSyncedAccounts(avant, [google('g1', 'un@gmail.com')]);
  check(
    'comptes : une synchronisation Google ne retire pas les comptes MEGA',
    apres.filter((compte) => compte.provider === 'mega').length === 2 &&
      apres.some((compte) => compte.id === 'gdrive-real-g1'),
    `${apres.filter((c) => c.provider === 'mega').length} MEGA survivant(s)`,
  );
  check(
    'comptes : une synchronisation ne retire jamais un compte absent du coffre',
    apres.some((compte) => compte.id === 'gdrive-real-g2'),
    'compte retiré par la synchronisation',
  );
  check(
    'comptes : une liste vide ne retire rien du tout',
    mergeSyncedAccounts(avant, []).length === avant.length,
    'liste vide appliquée comme une suppression',
  );
  check(
    'comptes : un compte nouveau est ajouté, un compte connu est mis à jour',
    (() => {
      const nouveau = google('g9', 'neuf@gmail.com');
      const fusion = mergeSyncedAccounts([google('g1', 'un@gmail.com')], [nouveau]);
      return fusion.length === 2 && fusion.some((compte) => compte.id === 'gdrive-real-g9');
    })(),
    'ajout ou mise à jour raté',
  );

  // 2. Le coffre Google refuse d'écrire ce qu'il n'a pas su relire.
  const { Vault } = await import('../google/vault.ts');
  const sceller = (clair) => Buffer.from(`k:${clair}`, 'utf8');
  const desceller = (chiffre) => {
    const texte = chiffre.toString('utf8');
    return texte.startsWith('k:') ? texte.slice(2) : null;
  };

  const dossierCoffre = join(fichier, 'coffre');
  const { mkdir: creerDossier } = await import('node:fs/promises');
  await creerDossier(dossierCoffre, { recursive: true });

  const compte = (id) => ({
    id,
    name: id,
    email: `${id}@gmail.com`,
    usedBytes: 0,
    quotaBytes: 0,
    status: 'connected',
    createdAt: '2026-01-01T00:00:00.000Z',
    tokens: { accessToken: `jeton-${id}`, expiresAt: Date.now() + 3600_000 },
  });

  const coffre = new Vault(dossierCoffre, sceller, desceller);
  await coffre.update((brouillon) => {
    brouillon.accounts.push(compte('a1'));
  });
  check(
    'coffre : un compte ajouté est relu au lancement suivant',
    (await new Vault(dossierCoffre, sceller, desceller).read()).accounts.length === 1,
    'compte non relu',
  );

  // Deux enregistrements simultanés ne doivent pas se recouvrir.
  const coffre2 = new Vault(dossierCoffre, sceller, desceller);
  await Promise.all([
    coffre2.update((brouillon) => brouillon.accounts.push(compte('b1'))),
    coffre2.update((brouillon) => brouillon.accounts.push(compte('b2'))),
  ]);
  const relus = (await new Vault(dossierCoffre, sceller, desceller).read()).accounts;
  check(
    'coffre : deux enregistrements simultanés sont tous les deux conservés',
    relus.some((c) => c.id === 'b1') && relus.some((c) => c.id === 'b2'),
    `${relus.length} compte(s) : ${relus.map((c) => c.id).join(', ')}`,
  );

  // Fichier illisible sans sauvegarde : aucune écriture ne doit l'écraser.
  const dossierCasse = join(fichier, 'coffre-casse');
  await creerDossier(dossierCasse, { recursive: true });
  const { writeFile: ecrire } = await import('node:fs/promises');
  await ecrire(join(dossierCasse, 'google-accounts.enc'), 'pas du tout un coffre');
  const coffreCasse = new Vault(dossierCasse, sceller, desceller);
  let refus = false;
  try {
    await coffreCasse.update((brouillon) => brouillon.accounts.push(compte('x1')));
  } catch {
    refus = true;
  }
  const contenuApres = await readFile(join(dossierCasse, 'google-accounts.enc'), 'utf8');
  check(
    'coffre : un fichier illisible est protégé, jamais écrasé',
    refus && contenuApres === 'pas du tout un coffre',
    refus ? 'fichier modifié malgré le refus' : 'écriture acceptée sur un coffre illisible',
  );

  // Sauvegarde de secours : le coffre déchiffrable précédent est restauré.
  const dossierSauve = join(fichier, 'coffre-sauve');
  await creerDossier(dossierSauve, { recursive: true });
  const coffreSain = new Vault(dossierSauve, sceller, desceller);
  await coffreSain.update((brouillon) => brouillon.accounts.push(compte('s1')));
  await coffreSain.update((brouillon) => brouillon.accounts.push(compte('s2')));
  // Sauvegarde présente (créée au premier écrasement), fichier principal cassé.
  await ecrire(join(dossierSauve, 'google-accounts.enc'), 'corrompu');
  const restaure = new Vault(dossierSauve, sceller, desceller);
  const contenuRestaure = await restaure.read();
  check(
    'coffre : une sauvegarde lisible est restaurée quand le fichier principal est cassé',
    contenuRestaure.accounts.length >= 1,
    `${contenuRestaure.accounts.length} compte(s) restauré(s)`,
  );

  // 3. Le coffre MEGA se protège de la même façon.
  const { MegaVault } = await import('../mega/store.ts');
  const dossierMega = join(fichier, 'mega-casse');
  await creerDossier(dossierMega, { recursive: true });
  await ecrire(join(dossierMega, 'mega-sessions.enc'), 'illisible');
  const megaCoffre = new MegaVault(dossierMega, sceller, desceller);
  check('MEGA : un coffre illisible ne renvoie aucun compte', (await megaCoffre.read()).length === 0);
  let megaRefus = false;
  try {
    await megaCoffre.write([]);
  } catch {
    megaRefus = true;
  }
  check(
    'MEGA : un coffre illisible refuse toute écriture',
    megaRefus &&
      (await readFile(join(dossierMega, 'mega-sessions.enc'), 'utf8')) === 'illisible',
    'sessions MEGA écrasées',
  );

  // 4. Diagnostic du coffre : ce que le disque contient réellement.
  const coffreDiag = new Vault(dossierSauve, sceller, desceller);
  await coffreDiag.read();
  const rapport = await coffreDiag.describe();
  check(
    'coffre : le diagnostic annonce les comptes réellement enregistrés',
    rapport.comptes.length >= 1 && rapport.existe && rapport.octets > 0,
    `${rapport.comptes.length} compte(s), fichier ${rapport.existe ? 'présent' : 'absent'}`,
  );
  check(
    'coffre : le diagnostic ne divulgue aucun jeton',
    rapport.comptes.every(
      (compte) => !('tokens' in compte) && !('accessToken' in compte) && !('refreshToken' in compte),
    ) &&
      !JSON.stringify(rapport).includes('jeton-'),
    'un jeton figure dans le rapport',
  );
  check(
    'coffre : le diagnostic signale la copie de secours',
    rapport.voisins.some((voisin) => voisin.nom.endsWith('.bak')),
    'sauvegarde non signalée',
  );

  // 5. MEGA : plus de canal permanent, une session à la fois, message clair.
  const racine = fileURLToPath(new URL('../..', import.meta.url));
  const sourceSession = await readFile(join(racine, 'desktop/mega/session.ts'), 'utf8');
  check(
    'MEGA : aucune connexion permanente (source de blocages -16 et de veilles)',
    !/keepalive:\s*true/.test(sourceSession) && /keepalive:\s*false/.test(sourceSession),
    'keepalive encore actif',
  );
  check(
    'MEGA : les sessions sont rouvertes une par une',
    /this\.file\s*\.\s*catch/.test(sourceSession) && /une session à la fois/.test(sourceSession),
    'aucune file d’attente',
  );
  check(
    'MEGA : un blocage temporaire impose une garde avant nouvel essai',
    /bloques\.set\(accountId, Date\.now\(\) \+ 3 \* 60_000\)/.test(sourceSession),
    'aucune garde après un -16',
  );

  const { messageErreurMega } = await import('../mega/files.ts');
  const message = messageErreurMega(Object.assign(new Error('EBLOCKED'), { code: -16 }));
  check(
    'MEGA : le blocage temporaire est expliqué, pas résumé à un code',
    /bloque/i.test(message) && /patientez/i.test(message),
    message,
  );

  // 6. La sentinelle ne compte pas le temps passé en arrière-plan.
  const sourceSentinelle = await readFile(join(racine, 'src/hooks/useFreezeWatchdog.ts'), 'utf8');
  check(
    'figements : une fenêtre masquée n’est plus signalée comme figée',
    /visibilityState === 'visible'/.test(sourceSentinelle) &&
      /document\.addEventListener\('visibilitychange'/.test(sourceSentinelle),
    'mesure encore active en arrière-plan',
  );

  // 6bis. Le retrait d'un compte ne révoque plus depuis le reducer.
  const sourceStore = await readFile(join(racine, 'src/store.tsx'), 'utf8');
  const blocRemove = sourceStore
    .slice(sourceStore.indexOf("case 'account/remove':"))
    .slice(0, 700);
  check(
    'comptes : le reducer ne révoque plus rien (il doit rester pur)',
    !/google\.disconnect|getBridge/.test(blocRemove),
    'effet de bord encore présent dans le reducer',
  );

  // 7. Supprimer un compte Google le retire aussi du coffre.
  const sourceClouds = await readFile(join(racine, 'src/pages/Clouds.tsx'), 'utf8');
  check(
    'comptes : la suppression d’un compte Google révoque aussi le coffre',
    /google\.disconnect\(reel\)/.test(sourceClouds),
    'coffre non révoqué à la suppression',
  );

  // 7bis. Même adresse des deux côtés : les identifiants ne se recouvrent pas.
  {
    const mega = (id, email, idApp) => ({
      id: idApp,
      provider: 'mega',
      megaId: id,
      source: 'mega',
      name: email.split('@')[0],
      email,
      usedBytes: 1,
      quotaBytes: 2,
      status: 'connected',
      createdAt: '2026-01-01T00:00:00.000Z',
      seed: 11,
      localTree: false,
    });

    // Un compte MEGA qui a volé l'identifiant d'un compte Google.
    const vole = mega('m1', 'firstboitier1@gmail.com', 'gdrive-real-gdrive-h1');
    const repare = normalizeAccounts([vole]);
    check(
      'comptes : un identifiant volé entre fournisseurs est rétabli',
      repare.length === 1 && repare[0].id === 'mega-real-m1' && repare[0].provider === 'mega',
      repare[0]?.id ?? 'aucun',
    );

    const googleVole = {
      id: 'mega-real-m2',
      provider: 'gdrive',
      googleId: 'gdrive-h2',
      source: 'google',
      name: 'deux',
      email: 'deux@gmail.com',
      usedBytes: 1,
      quotaBytes: 2,
      status: 'connected',
      createdAt: '2026-01-01T00:00:00.000Z',
      seed: 7,
      localTree: false,
    };
    const repare2 = normalizeAccounts([googleVole]);
    check(
      'comptes : le rétablissement fonctionne dans les deux sens',
      repare2[0]?.id === 'gdrive-real-gdrive-h2',
      repare2[0]?.id ?? 'aucun',
    );

    // Un identifiant sain n'est jamais renommé (favoris et transferts y sont liés).
    const sain = google('g7', 'sain@gmail.com');
    check(
      'comptes : un identifiant cohérent n’est jamais renommé',
      normalizeAccounts([sain])[0]?.id === sain.id,
      normalizeAccounts([sain])[0]?.id,
    );

    // Deux fournisseurs, même adresse : les deux doivent survivre à la fusion.
    const fusion = mergeSyncedAccounts(
      [mega('m1', 'partage@gmail.com', 'mega-real-m1'), google('g1', 'partage@gmail.com')],
      [google('g1', 'partage@gmail.com')],
    );
    check(
      'comptes : deux fournisseurs peuvent partager une adresse',
      fusion.filter((compte) => compte.email === 'partage@gmail.com').length === 2,
      `${fusion.length} compte(s)`,
    );

    // Une synchronisation ne convertit jamais un compte d'un fournisseur à l'autre.
    const tentative = mergeSyncedAccounts(
      [mega('m3', 'trois@gmail.com', 'mega-real-m3')],
      [{ ...google('g3', 'trois@gmail.com'), id: 'mega-real-m3' }],
    );
    check(
      'comptes : une synchronisation ne peut pas convertir un compte',
      tentative.length === 1 && tentative[0].provider === 'mega',
      tentative[0]?.provider,
    );
  }

  // 7ter. Stockage : les groupes suivent le registre des fournisseurs.
  {
    const sourceStockage = await readFile(join(racine, 'src/pages/Storage.tsx'), 'utf8');
    check(
      'stockage : les groupes viennent du registre, pas d’une liste en dur',
      /PROVIDER_IDS\.map\(/.test(sourceStockage) &&
        !/'gdrive'.*'mega'|'mega'.*'gdrive'/.test(sourceStockage),
      'groupement codé en dur',
    );
    check(
      'stockage : un compte non-Google n’est plus déclaré sans quota',
      !/Seul un compte Google connecté expose un quota réel/.test(sourceStockage),
      'ancien message encore présent',
    );
    check(
      'stockage : l’absence de détail par type est expliquée',
      /sans détail par type/.test(sourceStockage),
      'explication absente',
    );
    const catalog = await readFile(join(racine, 'src/data/catalog.ts'), 'utf8');
    check(
      'fournisseurs : le registre reste le seul point d’ajout',
      /export const PROVIDER_IDS: ProviderId\[\]/.test(catalog) &&
        /export const PROVIDERS: Record<ProviderId, Provider>/.test(catalog),
      'registre introuvable',
    );
  }

  // 8. La synchronisation réessaie, se note, et se rétablit.
  const sourceStoreSync = await readFile(join(racine, 'src/store.tsx'), 'utf8');
  check(
    'comptes : la synchronisation réessaie après un échec',
    /const delais = \[0, 400, 1200, 2500, 5000\]/.test(sourceStoreSync),
    'aucun réessai',
  );
  check(
    'comptes : une lecture manquée laisse une ligne dans le journal',
    /lecture du coffre échouée/.test(sourceStoreSync) &&
      /compte\(s\) Google à l'écran/.test(sourceStoreSync),
    'aucune trace du nombre affiché',
  );
  const blocSync = sourceStoreSync.slice(
    sourceStoreSync.indexOf('const tenter = async'),
    sourceStoreSync.indexOf("}, []);", sourceStoreSync.indexOf('const tenter = async')),
  );
  check(
    'comptes : le retour de la fenêtre relance une lecture, sans réveil périodique',
    /addEventListener\('visibilitychange', auRetour\)/.test(blocSync) &&
      !/setInterval/.test(blocSync),
    'relance mal câblée',
  );

  const sourceGoogle = await readFile(join(racine, 'src/lib/google.ts'), 'utf8');
  check(
    'comptes : la lecture du coffre lève au lieu de renvoyer une liste vide',
    /export async function syncGoogleAccounts/.test(sourceGoogle) &&
      /throw new Error\('pont indisponible'\)/.test(sourceGoogle),
    'échec encore silencieux',
  );

  const sourceMegaHook = await readFile(join(racine, 'src/hooks/useMega.ts'), 'utf8');
  check(
    'comptes : un compte MEGA n’est apparié qu’à un compte MEGA',
    /function megaExistant/.test(sourceMegaHook) &&
      /compte\.provider === 'mega' &&/.test(sourceMegaHook) &&
      (sourceMegaHook.match(/compte\.email === info\.email/g) ?? []).length === 1,
    `${(sourceMegaHook.match(/compte\.email === info\.email/g) ?? []).length} appariement(s) par adresse`,
  );
  const sourceStoreGarde = await readFile(join(racine, 'src/store.tsx'), 'utf8');
  check(
    'comptes : aucun compte ne peut changer de fournisseur',
    /if \(previous\.provider !== next\.provider\) return previous;/.test(sourceStoreGarde),
    'garde-fou absent du reducer',
  );
  check(
    'comptes : l’état enregistré est réparé au chargement',
    /normalizeAccounts\(/.test(sourceStoreGarde),
    'réparation absente',
  );
  check(
    'MEGA : les onze comptes arrivent en une seule action',
    /type: 'account\/addMany'/.test(sourceMegaHook),
    'encore un dispatch par compte',
  );

  // 9. La sentinelle utilise une horloge monotone.
  const sentinelle = await readFile(join(racine, 'src/hooks/useFreezeWatchdog.ts'), 'utf8');
  check(
    'figements : horloge monotone (les sauts d’heure ne comptent plus)',
    /performance\.now\(\) \+ PERIODE_MS/.test(sentinelle) && !/Date\.now\(\) \+ PERIODE_MS/.test(sentinelle),
    'horloge murale encore utilisée',
  );

  // 10. Un pont incomplet ne casse plus l'interface.
  const sourceCloud = await readFile(join(racine, 'src/lib/cloud.ts'), 'utf8');
  check(
    'pont : une méthode MEGA absente ne fait plus tomber l’écran',
    /typeof bridge\?\.mega\?\.onUpload !== 'function'/.test(sourceCloud),
    'appel non protégé',
  );

  // 11. Le canal de notes est déclaré, exposé et journalisé.
  const apiSource = await readFile(join(racine, 'desktop/api.ts'), 'utf8');
  const preloadSource = await readFile(join(racine, 'desktop/preload.cjs'), 'utf8');
  check(
    'journal : l’interface peut écrire une ligne de diagnostic',
    /note: 'desktop:note'/.test(apiSource) &&
      apiSource.includes('ipcMain.on(channels.note') &&
      /note: \(message\) => ipcRenderer.send\('desktop:note'/.test(preloadSource),
    'canal absent',
  );
  check(
    'journal : les notes de l’interface sont bornées',
    /notesEmises >= 40/.test(apiSource),
    'aucune borne',
  );

  await rm(fichier, { recursive: true, force: true }).catch(() => undefined);
}

/* --- 30. Le paquet se charge sans dépendance absente --------------------- */
//
// `megajs` (protocole MEGA) est empaqueté dans `main.cjs`, et `node_modules`
// est exclu de l'archive : si l'empaquetage oubliait une dépendance, le défaut
// n'apparaîtrait qu'au lancement, chez l'utilisateur, par une fenêtre qui ne
// s'ouvre pas. On charge donc le fichier livré dans Node, avec un `electron`
// factice, et l'on vérifie que le seul obstacle est Electron lui-même.
{
  const { writeFile: ecrire } = await import('node:fs/promises');
  const script = join(await mkdtemp(join(tmpdir(), 'boitier-charge-')), 'charge.mjs');
  const { fileURLToPath } = await import('node:url');
  const bundle = fileURLToPath(new URL('../dist/main.cjs', import.meta.url));
  await ecrire(
    script,
    `import Module from 'node:module';
const original = Module._load;
const factice = new Proxy(function () {}, { get: () => factice, apply: () => factice });
Module._load = function (demande, parent, principal) {
  if (demande === 'electron') return factice;
  return original.call(this, demande, parent, principal);
};
try {
  await import(${JSON.stringify(`file://${bundle}`)});
} catch (erreur) {
  console.log('ERREUR ' + erreur.message);
}
process.exit(0);
`,
    'utf8',
  );
  const { spawn } = await import('node:child_process');
  const sortie = await new Promise((resolve) => {
    const enfant = spawn(process.execPath, [script], { cwd: tmpdir() });
    let texte = '';
    enfant.stdout.on('data', (morceau) => (texte += morceau.toString('utf8')));
    enfant.stderr.on('data', (morceau) => (texte += morceau.toString('utf8')));
    enfant.on('close', () => resolve(texte));
    setTimeout(() => enfant.kill(), 20_000);
  });
  check(
    'paquet : aucune dépendance absente au chargement',
    !/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(sortie),
    sortie.split('\n')[0] || 'sortie vide',
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

/**
 * Serveur qui sert un fichier par tranches, avec ou sans plage `Range`.
 *
 * `ranges` conserve les en-têtes reçus : c'est la preuve qu'une reprise a
 * réellement demandé la suite, et non retéléchargé le fichier entier.
 */
async function rangeServer({ total = 200_000, chunk = 20_000, delay = 20, ignoreRange = false } = {}) {
  const { createServer } = await import('node:http');
  const ranges = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('alt') === 'media') {
      const entete = req.headers.range;
      if (entete) ranges.push(entete);
      const demande = ignoreRange ? null : /^bytes=(\d+)-/.exec(entete ?? '');
      const debut = demande ? Number(demande[1]) : 0;
      const corps = Buffer.alloc(total - debut, 0x42);
      res.writeHead(debut > 0 ? 206 : 200, {
        'content-type': 'video/mp4',
        'content-length': String(corps.length),
        ...(debut > 0 ? { 'content-range': `bytes ${debut}-${total - 1}/${total}` } : {}),
      });
      for (let i = 0; i < corps.length; i += chunk) {
        if (res.destroyed || res.writableEnded) return;
        res.write(corps.subarray(i, i + chunk));
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'f', name: 'v.mp4', mimeType: 'video/mp4', size: String(total) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.ranges = ranges;
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
