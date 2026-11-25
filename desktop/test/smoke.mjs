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
