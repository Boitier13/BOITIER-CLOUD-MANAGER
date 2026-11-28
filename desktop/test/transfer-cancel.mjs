import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DownloadManager } from '../google/downloads.ts';
const dir = await mkdtemp(join(tmpdir(), 'boitier-annulation-'));
try {
  const events = [];
  const adapter = {
    readMeta: async () => ({ mimeType: 'video/mp4', size: 100 }),
    openMedia: async (_account, _file, signal) => {
      const body = new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        signal.addEventListener('abort', () => controller.error(new DOMException('Arrêt', 'AbortError')), { once: true });
      } });
      return { body, size: 100, start: 0, resumed: false };
    },
  };
  const manager = new DownloadManager({ drive: '' }, (event) => events.push(event), async () => dir, { adapter, stallMs: 5000 });
  await manager.start({ id: 'job', fileId: 'file', name: 'file.mp4', size: 100, dir }, 'account');
  for (let i = 0; i < 100 && !events.some((e) => e.received > 0); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some((e) => e.received > 0));
  manager.cancel('job');
  for (let i = 0; i < 100 && !events.some((e) => e.cancelled); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some((e) => e.cancelled && e.status === 'error'), 'événement terminal distinct sans notification d’échec');
  assert.deepEqual(await readdir(dir), [], 'fichier partiel effacé après fermeture');
  assert.equal(manager.list().length, 0);
  // Si la pause vient juste de s'achever avant l'annulation, un événement
  // terminal reste nécessaire pour libérer la place de la file renderer.
  const pausedEvents = [];
  const pausedManager = new DownloadManager({ drive: '' }, (e) => pausedEvents.push(e), async () => dir, { adapter, stallMs: 5000 });
  await pausedManager.start({ id: 'pause-then-cancel', fileId: 'file', name: 'pause.mp4', size: 100, dir }, 'account');
  for (let i = 0; i < 100 && !pausedEvents.some((e) => e.received > 0); i++) await new Promise((r) => setTimeout(r, 10));
  pausedManager.pause('pause-then-cancel');
  for (let i = 0; i < 100 && !pausedEvents.some((e) => e.status === 'paused'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(pausedEvents.some((e) => e.status === 'paused'));
  await pausedManager.cancel('pause-then-cancel');
  assert.equal(pausedEvents.at(-1).cancelled, true);
  assert.deepEqual(await readdir(dir), []);

  console.log('✔ Annulation volontaire : flux fermé et partiel supprimé');
} finally { await rm(dir, { recursive: true, force: true }); }
