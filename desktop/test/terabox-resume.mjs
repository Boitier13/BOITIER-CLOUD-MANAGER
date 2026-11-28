import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TeraBoxWebClient } from '../terabox/web-client.ts';
import { TeraBoxService } from '../terabox/service.ts';
import { TeraBoxVault } from '../terabox/vault.ts';
const dir = await mkdtemp(join(tmpdir(), 'boitier-terabox-resume-'));
const secret = 'test-private-session';
const contents = Buffer.from('abcdefghij');
const json = (value) => new Response(JSON.stringify(value));
const fileId = `tb_${Buffer.from('/test.bin').toString('base64url')}`;
try {
  for (const mode of ['partial', 'no-validator', 'weak-validator', 'ignored-range', 'wrong-range', 'changed-etag', 'changed-size']) {
    const folder = join(dir, mode);
    const events = [], calls = [];
    let contentCount = 0, size = 10;
    const etag = mode === 'no-validator' ? undefined : mode === 'weak-validator' ? 'W/"v1"' : '"v1"';
    const transport = async (url, init) => {
      if (url.pathname === '/api/check/login') return json({ errno: 0, uk: 10001 });
      if (url.pathname === '/api/quota') return json({ errno: 0, used: 10, total: 100 });
      if (url.pathname === '/api/filemetas') return json({ errno: 0, info: [{ path: '/test.bin', isdir: 0, server_filename: 'test.bin', size, dlink: 'https://data.terabox.com/file' }] });
      assert.equal(url.hostname, 'data.terabox.com');
      assert.equal(init.headers.cookie, undefined);
      calls.push(init.headers);
      contentCount++;
      if (contentCount === 1) {
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(contents.subarray(0, 4));
          init.signal.addEventListener('abort', () => controller.error(new DOMException('Arrêt', 'AbortError')), { once: true });
        } }), { status: 200, headers: { 'content-length': '10', ...(etag ? { etag } : {}) } });
      }
      if (mode === 'changed-size') return new Response('abcdefghijk', { status: 200, headers: { 'content-length': '11', etag: '"v1"' } });
      if (mode === 'no-validator' || mode === 'weak-validator' || mode === 'ignored-range') {
        return new Response(contents, { status: 200, headers: { 'content-length': '10', etag: '"v2"' } });
      }
      const headers = { etag: mode === 'changed-etag' ? '"v2"' : '"v1"', 'content-range': mode === 'wrong-range' ? 'bytes 3-9/10' : 'bytes 4-9/10', 'content-length': '6' };
      return new Response(contents.subarray(4), { status: 206, headers });
    };
    const vault = new TeraBoxVault(folder, (s) => Buffer.from(s), (b) => b.toString());
    const service = new TeraBoxService(vault, transport, undefined, { emit: (e) => events.push(e), fallbackDir: async () => folder });
    const account = await service.connect(secret, 'Compte');
    await service.download({ id: mode, accountId: account.accountId, fileId, name: 'test.bin', size: 10 });
    for (let i = 0; i < 200 && !events.some((e) => e.received === 4); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(events.some((e) => e.received === 4), `${mode} : premier bloc reçu`);
    service.pause(mode);
    for (let i = 0; i < 200 && !events.some((e) => e.status === 'paused'); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(events.some((e) => e.status === 'paused'));
    if (mode === 'changed-size') size = 11;
    await service.resume(mode);
    for (let i = 0; i < 200 && !events.some((e) => e.status === 'done' || e.status === 'error'); i++) await new Promise((r) => setTimeout(r, 5));
    if (mode === 'wrong-range' || mode === 'changed-etag') {
      assert.ok(events.some((e) => e.status === 'error'), `${mode} : arrêt sans assemblage dangereux`);
      assert.equal((await readFile(join(folder, 'test.bin.part'))).toString(), 'abcd');
      assert.ok(!(await readdir(folder)).includes('test.bin'));
    } else {
      assert.ok(events.some((e) => e.status === 'done'), `${mode} : téléchargement terminé`);
      assert.deepEqual(await readFile(join(folder, 'test.bin')), mode === 'changed-size' ? Buffer.from('abcdefghijk') : contents);
    }
    if (mode === 'partial' || mode === 'ignored-range' || mode === 'wrong-range' || mode === 'changed-etag') {
      assert.equal(calls[1].range, 'bytes=4-');
      assert.equal(calls[1]['if-range'], '"v1"');
    }
    if (mode === 'no-validator' || mode === 'weak-validator' || mode === 'changed-size') assert.equal(calls[1].range, undefined);
  }
  // Une réponse partielle non demandée ou une taille de plage incohérente ne
  // doit jamais être acceptée, même venant d'un domaine autorisé.
  for (const headers of [
    { etag: '"v1"', 'content-range': 'bytes 4-9/10', 'content-length': '5' },
    { etag: '"v1"', 'content-range': 'bytes 4-9/10', 'content-encoding': 'gzip' },
    { 'content-range': 'bytes 4-9/10' },
  ]) {
    const client = new TeraBoxWebClient(secret, async () => new Response('abcdef', { status: 206, headers }));
    await assert.rejects(client.openContent('https://data.terabox.com/file', 10, 'test.bin', new AbortController().signal, { from: 4, etag: '"v1"' }));
  }
  const unsolicited = new TeraBoxWebClient(secret, async () => new Response('abcdef', { status: 206, headers: { etag: '"v1"' } }));
  await assert.rejects(unsolicited.openContent('https://data.terabox.com/file', 10, 'test.bin', new AbortController().signal));
  console.log('✔ Reprise TeraBox : plage validée, vérification ETag, repli et changements détectés');
} finally { await rm(dir, { recursive: true, force: true }); }
