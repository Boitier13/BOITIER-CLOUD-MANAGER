import assert from 'node:assert/strict';
import { TransferReloadGuard } from '../transfer-reload-guard.ts';

const guard = new TransferReloadGuard(80);
const calls = [];
guard.rendererReady();
let resolveStart;
const held = new Promise((resolve) => { resolveStart = resolve; });
const a = guard.start('a', async () => { calls.push('start-a'); await held; }, () => { calls.push('pause-a'); });
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(calls, ['start-a']);
guard.interrupt();
assert.deepEqual(calls, ['start-a'], 'ne pas arrêter un fournisseur avant son initialisation');
guard.rendererReady();
const b = guard.start('b', async () => { calls.push('start-b'); }, () => { calls.push('pause-b'); });
guard.observe({ id: 'a', status: 'running', received: 0, size: 10, speed: 0 });
assert.deepEqual(calls, ['start-a', 'pause-a']);
await Promise.resolve(); assert.ok(!calls.includes('start-b'), 'la barrière attend la fermeture du flux');
guard.observe({ id: 'a', status: 'paused', received: 2, size: 10, speed: 0 });
await b; assert.ok(calls.includes('start-b'));
resolveStart(); await a;
// Un ancien démarrage en attente ne peut pas traverser deux générations.
guard.observe({ id: 'b', status: 'running', received: 0, size: 10, speed: 0 });
guard.interrupt(); guard.rendererReady();
const stale = guard.start('c', async () => { calls.push('unexpected-c'); }, () => {});
guard.interrupt(); guard.rendererReady();
guard.observe({ id: 'b', status: 'paused', received: 0, size: 10, speed: 0 });
await assert.rejects(stale, /rechargée/);
assert.ok(!calls.includes('unexpected-c'));
// Une pause refusée ne libère pas la barrière, même après le délai maximal.
const blocked = new TransferReloadGuard(20); blocked.rendererReady();
await blocked.start('x', async () => {}, () => { throw new Error('refus'); });
blocked.interrupt(); blocked.rendererReady();
await assert.rejects(blocked.start('y', async () => { throw new Error('ne doit pas démarrer'); }, () => {}), /pas encore arrêtés/);
blocked.observe({ id: 'x', status: 'done', received: 1, size: 1, speed: 0 });
await blocked.start('y', async () => {}, () => {});
// Un appel qui n'a pas encore démarré au moment du rechargement est refusé.
const early = new TransferReloadGuard(); early.rendererReady();
const old = early.start('old', async () => { throw new Error('lancement interdit'); }, () => {});
early.interrupt(); early.rendererReady();
await assert.rejects(old, /rechargée/);
console.log('✔ Rechargement : pause des flux, barrière et appels des anciennes fenêtres');

// Intégration avec le vrai gestionnaire commun Google / Shadow / TeraBox :
// rechargement au milieu d'un flux et pendant la préparation du compte.
const { DownloadManager } = await import('../google/downloads.ts');
const { mkdtemp, rm, readdir } = await import('node:fs/promises');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');
const dir = await mkdtemp(join(tmpdir(), 'boitier-reload-'));
try {
  const lifecycle = new TransferReloadGuard(1000); lifecycle.rendererReady();
  const events = [];
  const adapter = {
    readMeta: async () => ({ mimeType: 'video/mp4', size: 100 }),
    openMedia: async (_account, _file, signal) => ({ size: 100, start: 0, resumed: false, body: new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      signal.addEventListener('abort', () => controller.error(new DOMException('Arrêt', 'AbortError')), { once: true });
    } }) }),
  };
  const manager = new DownloadManager({ drive: '' }, (e) => { events.push(e); lifecycle.observe(e); }, async () => dir, { adapter, stallMs: 5000 });
  const req = { id: 'stream', fileId: 'file', name: 'file.mp4', size: 100, dir };
  await lifecycle.start(req.id, () => manager.start(req, 'account'), () => manager.pause(req.id));
  for (let i = 0; i < 100 && !events.some((e) => e.received > 0); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some((e) => e.received > 0));
  lifecycle.interrupt(); lifecycle.rendererReady();
  let afterPause = false;
  await lifecycle.start('next', async () => { afterPause = events.some((e) => e.status === 'paused'); }, () => {});
  assert.ok(afterPause, 'le prochain flux ne démarre qu’après la fermeture et la pause');
  lifecycle.observe({ id: 'next', status: 'done', received: 0, size: 0, speed: 0 });
  assert.ok((await readdir(dir)).some((n) => n.endsWith('.part')));
  let releaseAuth; const auth = new Promise((resolve) => { releaseAuth = resolve; });
  let startedAfterAuth = false;
  const pending = lifecycle.start('auth', async () => { await auth; await manager.start({ ...req, id: 'auth', name: 'auth.mp4' }, 'account'); startedAfterAuth = true; }, () => manager.pause('auth'));
  await Promise.resolve(); await Promise.resolve();
  lifecycle.interrupt(); lifecycle.rendererReady();
  const later = lifecycle.start('later', async () => { assert.ok(events.some((e) => e.id === 'auth' && e.status === 'paused')); }, () => {});
  releaseAuth(); await pending; await later;
  assert.ok(startedAfterAuth);
  console.log('✔ Rechargement avec gestionnaire réel : flux et authentification en cours');
} finally { await rm(dir, { recursive: true, force: true }); }
