import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowVault } from '../shadow/vault.ts';
import { ShadowService, validateRoot } from '../shadow/service.ts';

const dir = await mkdtemp(join(tmpdir(), 'shadow-test-'));
let origin; let root;
const auth = `Basic ${Buffer.from('user:secret-token').toString('base64')}`;
const files = {
  '/remote.php/webdav/': { folder: true, children: ['Dossier/', 'notes.txt'] },
  '/remote.php/webdav/Dossier/': { folder: true, children: ['Test.txt'] },
  '/remote.php/webdav/Dossier/Test.txt': { body: 'Contenu en sous-dossier' },
  '/remote.php/webdav/notes.txt': { body: 'Salut Shadow' },
};
const xmlRow = (path, entry) => `<d:response><d:href>${path}</d:href><d:propstat><d:prop><d:resourcetype>${entry.folder ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${entry.body?.length ?? 0}</d:getcontentlength><d:getlastmodified>Wed, 21 Oct 2015 07:28:00 GMT</d:getlastmodified><d:quota-used-bytes>100</d:quota-used-bytes><d:quota-available-bytes>900</d:quota-available-bytes></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const server = createServer((req, res) => {
  if (req.headers.authorization !== auth) { res.writeHead(401).end(); return; }
  const path = new URL(req.url, origin).pathname;
  if (path === '/remote.php/redirect/') { res.writeHead(302, { location: `${origin}/remote.php/webdav/` }).end(); return; }
  const entry = files[path];
  if (!entry) { res.writeHead(404).end(); return; }
  if (req.method === 'PROPFIND') {
    const children = req.headers.depth === '1' && entry.children ? entry.children.map((name) => xmlRow(path + name, files[path + name])).join('') : '';
    res.writeHead(207, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${xmlRow(path, entry)}${children}</d:multistatus>`);
  } else if (req.method === 'GET' && entry.body) {
    res.writeHead(200, { 'content-length': Buffer.byteLength(entry.body) }); res.end(entry.body);
  } else res.writeHead(405).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
origin = `http://127.0.0.1:${server.address().port}`;
root = `${origin}/remote.php/webdav/`;
try {
  const protect = (plain) => Buffer.from(`enc:${plain}`).reverse();
  const unprotect = (cipher) => Buffer.from(cipher).reverse().toString().slice(4);
  const vault = new ShadowVault(dir, protect, unprotect);
  const events = [];
  const service = new ShadowService(vault, (event) => events.push(event), async () => dir, origin);
  assert.throws(() => validateRoot('https://attacker.example/remote.php/webdav/'));
  assert.throws(() => validateRoot('https://drive.shadow.tech@attacker.example/remote.php/webdav/'));
  assert.throws(() => validateRoot('http://drive.shadow.tech/remote.php/webdav/'));
  await assert.rejects(service.connect('user', 'wrong-token', root), /refuse l’accès/);
  await assert.rejects(service.connect('user', 'secret-token', `${origin}/remote.php/redirect/`), /redirection refusée/);
  const account = await service.connect('user', 'secret-token', root);
  assert.equal(account.quotaBytes, 1000);
  await assert.rejects(service.connect('another', 'secret-token', root, account.accountId), /ne correspond pas/);
  assert.equal((await service.accounts()).length, 1);
  assert.equal(JSON.stringify(account).includes('secret-token'), false);
  assert.equal((await readFile(join(dir, 'shadow-accounts.enc'))).includes(Buffer.from('secret-token')), false);
  const restored = new ShadowService(new ShadowVault(dir, protect, unprotect), (event) => events.push(event), async () => dir, origin);
  assert.equal((await restored.accounts()).length, 1);
  assert.equal((await restored.accounts())[0].url, root);
  await restored.connect('user', 'secret-token', root, account.accountId);
  assert.equal((await restored.accounts()).length, 1);
  const entries = await restored.list(account.accountId, 'root');
  assert.deepEqual(entries.map((entry) => entry.name), ['Dossier', 'notes.txt']);
  const folder = entries[0], file = entries[1];
  const plan = await restored.plan(account.accountId, 'root');
  assert.deepEqual(plan.files.map((f) => f.path).sort(), ['Dossier/Test.txt', 'notes.txt']);
  assert.deepEqual(plan.folders, ['Dossier']);
  await restored.download({ id: 'one', accountId: account.accountId, fileId: file.id, name: file.name, size: file.size, subPath: 'Shadow Drive/Documents' });
  for (let i = 0; i < 100 && !events.some((e) => e.id === 'one' && ['done', 'error'].includes(e.status)); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.find((e) => e.id === 'one' && e.status === 'error'), undefined);
  assert.equal(await readFile(join(dir, 'Shadow Drive', 'Documents', 'notes.txt'), 'utf8'), 'Salut Shadow');
  const children = await restored.list(account.accountId, folder.id);
  assert.equal(children[0].name, 'Test.txt');
  assert.deepEqual((await restored.search(account.accountId, 'test')).map((f) => f.name), ['Test.txt']);
  assert.deepEqual((await restored.recent(account.accountId)).map((f) => f.name).sort(), ['Test.txt', 'notes.txt']);
  assert.deepEqual((await restored.locate(account.accountId, children[0].id)).map((f) => f.name), ['Dossier']);
  await restored.prepareFolders('', ['Shadow Drive/empty/sous-dossier']);
  assert.equal((await stat(join(dir, 'Shadow Drive/empty/sous-dossier'))).isDirectory(), true);
  await assert.rejects(restored.prepareFolders('', Array(502).fill('x')), /invalide/);
  await assert.rejects(restored.list(account.accountId, Buffer.from('/remote.php/elsewhere').toString('base64url')), /hors du dossier/);
  await restored.disconnect(account.accountId);
  assert.equal((await restored.accounts()).length, 0);
  console.log('✔ Shadow Drive : coffre, sécurité, connexion, arborescence et téléchargement vérifiés');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
