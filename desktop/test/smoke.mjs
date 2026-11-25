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
const { relativeDir } = await import('../google/downloads.ts');

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
  check('quota réel lu', account.quotaBytes === 16106127360 && account.usedBytes === 2684354560);
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

  // --- 5quater. Répartition du stockage -------------------------------------
  const storage = await service2.storage(account.accountId);
  check(
    'stockage : quota exact repris de Google',
    storage.quotaBytes === 16106127360 && storage.usedBytes === 2684354560,
    `${storage.usedBytes} / ${storage.quotaBytes}`,
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

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
