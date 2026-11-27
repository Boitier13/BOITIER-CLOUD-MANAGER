import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeraBoxVault } from '../terabox/vault.ts';
import { TeraBoxService } from '../terabox/service.ts';
import { TeraBoxWebClient } from '../terabox/web-client.ts';

const secret = 'test-session-keep-private';
const requests = [];
const file = (path, directory = false) => ({ path, server_filename: path.split('/').pop(), isdir: directory ? 1 : 0, size: 12, server_mtime: 1700000000 });
const response = (value, options = {}) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200, ...options });
const fetcher = async (url, init) => {
  requests.push({ url: String(url), init });
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.cookie, `lang=en; ndus=${secret}`);
  assert.equal(String(url).includes(secret), false);
  assert.equal(url.protocol, 'https:');
  switch (url.pathname) {
    case '/api/check/login':
      return url.hostname === 'www.terabox.com' ? response('', { headers: { 'region-domain-prefix': 'jp' } }) : response({ errno: 0, uk: 10001 });
    case '/api/quota': return response({ errno: 0, used: 12, total: 1000 });
    case '/api/list': {
      const p = new URLSearchParams(init.body);
      const page = Number(p.get('page'));
      if (p.get('dir') === '/bad') return response({ errno: 0, list: [file('/ailleurs.txt')] });
      if (page === 1) return response({ errno: 0, list: Array.from({ length: 200 }, (_, i) => file(`/fichier-${i}.txt`)) });
      return response({ errno: 0, list: [file('/Dossier', true)] });
    }
    case '/api/search': return response({ errno: 0, list: [file('/fichier.txt')], has_more: 0 });
    case '/api/filemetas': return response({ errno: 0, info: [{ ...file('/fichier.txt'), dlink: 'https://cdn.example.test/fichier' }] });
    default: throw new Error('unexpected path');
  }
};

const client = new TeraBoxWebClient(secret, fetcher);
assert.equal(await client.identity(), '10001');
assert.equal(requests[1].url, 'https://jp.terabox.com/api/check/login');
assert.deepEqual(await client.quota(), { usedBytes: 12, quotaBytes: 1000 });
const listing = await client.list();
assert.equal(listing.length, 201);
assert.equal(listing.at(-1).directory, true);
assert.equal((await client.search('fichier'))[0].path, '/fichier.txt');
assert.deepEqual(await client.search('x'), []);
assert.equal((await client.fileMeta('/fichier.txt')).size, 12);
await assert.rejects(client.list('/bad'), /hors du dossier/);
await assert.rejects(client.list('/../forbidden'), /invalide/);
assert.throws(() => new TeraBoxWebClient('a; injected=x', fetcher), /invalide/);
const badRegion = new TeraBoxWebClient(secret, async () => response('', { headers: { 'region-domain-prefix': 'evil.example' } }));
await assert.rejects(badRegion.identity(), /Région/);
const redirection = new TeraBoxWebClient(secret, async () => { throw new Error('redirect'); });
await assert.rejects(redirection.identity(), /redirection refusée/);
const captcha = new TeraBoxWebClient(secret, async () => response('<html>verification</html>'));
await assert.rejects(captcha.identity(), /vérification/);
const expired = new TeraBoxWebClient(secret, async () => response({ errno: -6 }));
await assert.rejects(expired.identity(), /expirée/);
const huge = new TeraBoxWebClient(secret, async () => response('x'.repeat(4 * 1024 * 1024 + 1)));
await assert.rejects(huge.identity(), /volumineuse/);

const dir = await mkdtemp(join(tmpdir(), 'terabox-vault-test-'));
try {
  const protect = (s) => Buffer.from(`secured:${s}`).reverse();
  const unprotect = (b) => Buffer.from(b).reverse().toString().slice(8);
  const vault = new TeraBoxVault(dir, protect, unprotect);
  const service = new TeraBoxService(vault, fetcher);
  const connected = await service.connect(secret, 'Mon compte');
  assert.equal(connected.accountId, 'terabox-10001');
  assert.equal(JSON.stringify(connected).includes(secret), false);
  assert.equal((await readFile(join(dir, 'terabox-accounts.enc'))).includes(Buffer.from(secret)), false);
  const nodes = await service.list(connected.accountId, 'root');
  assert.equal(nodes.length, 201);
  assert.ok(nodes.every((node) => node.id.startsWith('tb_')));
  const search = await service.search(connected.accountId, 'fichier');
  assert.equal(search[0].name, 'fichier.txt');
  assert.deepEqual(await service.locate(connected.accountId, search[0].id), []);
  await assert.rejects(service.list(connected.accountId, 'tb_not/valid'), /invalide/);
  await assert.rejects(service.connect(secret, 'Autre', 'terabox-999'), /ne correspond pas/);
  assert.equal((await service.accounts()).length, 1);
  const restored = new TeraBoxService(new TeraBoxVault(dir, protect, unprotect), fetcher);
  assert.equal((await restored.accounts())[0].name, 'Mon compte');
  // Trois sessions distinctes ne doivent jamais s'échanger leurs fichiers.
  const multiTransport = async (url, init) => {
    const account = init.headers.cookie.includes('second-session-private') ? '2' : init.headers.cookie.includes('third-session-private') ? '3' : '1';
    if (url.pathname === '/api/check/login') return response({ errno: 0, uk: account });
    if (url.pathname === '/api/quota') return response({ errno: 0, used: Number(account), total: 1000 });
    if (url.pathname === '/api/list') {
      const path = new URLSearchParams(init.body).get('dir');
      return response({ errno: 0, list: path === '/' ? [file('/Dossier', true)] : [file(`/Dossier/compte-${account}.txt`)] });
    }
    throw new Error('unexpected call');
  };
  const multi = new TeraBoxService(vault, multiTransport);
  const first = await multi.connect(secret, 'Premier');
  const second = await multi.connect('second-session-private', 'Second');
  const third = await multi.connect('third-session-private', 'Troisième');
  assert.equal(new Set([first.accountId, second.accountId, third.accountId]).size, 3);
  const firstFolder = (await multi.list(first.accountId))[0];
  const secondFolder = (await multi.list(second.accountId))[0];
  const thirdFolder = (await multi.list(third.accountId))[0];
  assert.equal((await multi.list(first.accountId, firstFolder.id))[0].name, 'compte-1.txt');
  assert.equal((await multi.list(second.accountId, secondFolder.id))[0].name, 'compte-2.txt');
  assert.equal((await multi.list(third.accountId, thirdFolder.id))[0].name, 'compte-3.txt');
  const plan = await multi.plan(second.accountId, 'root');
  assert.deepEqual(plan.files.map((f) => f.path), ['Dossier/compte-2.txt']);
  assert.deepEqual(plan.folders, ['Dossier']);
  assert.equal((await multi.accounts()).length, 4);
  assert.equal(JSON.stringify(await multi.accounts()).includes('third-session-private'), false);
  await multi.disconnect(first.accountId);
  await multi.disconnect(second.accountId);
  await multi.disconnect(third.accountId);
  // Vérifie le contrat en injectant un autre lecteur fictif, sans service Web.
  let factoryCalls = 0;
  const alternateFactory = (session) => {
    assert.equal(session, secret);
    factoryCalls++;
    return {
      identity: async () => '10001',
      quota: async () => ({ usedBytes: 5, quotaBytes: 100 }),
      list: async () => [{ path: '/contrat.txt', name: 'contrat.txt', directory: false, size: 5, modified: '2024-01-01T00:00:00.000Z' }],
      search: async () => [],
    };
  };
  const substitute = new TeraBoxService(vault, () => { throw new Error('transport web interdit'); }, alternateFactory);
  assert.equal((await substitute.list(connected.accountId))[0].name, 'contrat.txt');
  assert.equal(factoryCalls, 1);
  const contentCalls = [];
  let truncated = false;
  const downloadTransport = async (url, init) => {
    if (url.hostname === 'data.terabox.com') {
      contentCalls.push({ url: String(url), headers: init.headers });
      if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
      if (url.pathname === '/html') return response('failure', { headers: { 'content-type': 'text/html' } });
      return new Response(truncated ? 'short' : 'hello world!', { status: 200 });
    }
    if (url.pathname === '/api/check/login') return response({ errno: 0, uk: 10001 });
    if (url.pathname === '/api/filemetas') return response({ errno: 0, info: [{ ...file('/fichier.txt'), dlink: 'https://data.terabox.com/file' }] });
    throw new Error('unexpected request');
  };
  const events = [];
  const downloadService = new TeraBoxService(vault, downloadTransport, undefined, { emit: (e) => events.push(e), fallbackDir: async () => dir });
  const fileId = `tb_${Buffer.from('/fichier.txt').toString('base64url')}`;
  await downloadService.download({ id: 'ok', accountId: connected.accountId, fileId, name: 'fichier.txt', size: 12 });
  for (let i = 0; i < 100 && !events.some((e) => e.id === 'ok' && ['done', 'error'].includes(e.status)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some((e) => e.id === 'ok' && e.status === 'done'));
  assert.equal(await readFile(join(dir, 'fichier.txt'), 'utf8'), 'hello world!');
  assert.ok(contentCalls.every((call) => !('cookie' in call.headers) && !('authorization' in call.headers)));
  truncated = true;
  await downloadService.download({ id: 'truncated', accountId: connected.accountId, fileId, name: 'truncated.txt', size: 12 });
  for (let i = 0; i < 100 && !events.some((e) => e.id === 'truncated' && ['done', 'error'].includes(e.status)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some((e) => e.id === 'truncated' && e.status === 'error'));
  await assert.rejects(stat(join(dir, 'truncated.txt')), { code: 'ENOENT' });
  const mediaClient = new TeraBoxWebClient(secret, downloadTransport);
  await assert.rejects(mediaClient.openContent('https://data.terabox.com/redirect', 12, 'fichier.txt', new AbortController().signal), /non autorisé/);
  await assert.rejects(mediaClient.openContent('https://evil.example/file', 12, 'fichier.txt', new AbortController().signal), /non autorisé/);
  await assert.rejects(mediaClient.openContent('https://data.terabox.com/html', 12, 'fichier.txt', new AbortController().signal), /page au lieu/);
  await restored.disconnect(connected.accountId);
  assert.equal((await restored.accounts()).length, 0);
  await writeFile(join(dir, 'terabox-accounts.enc'), 'corrupted');
  const corrupted = new TeraBoxVault(dir, protect, unprotect);
  await assert.rejects(corrupted.accounts(), /illisible/);
  await assert.rejects(corrupted.change(() => []), /illisible/);
} finally { await rm(dir, { recursive: true, force: true }); }
console.log('✔ TeraBox web expérimental : identité, région, pagination, quota, recherche et coffre vérifiés (serveur simulé)');
