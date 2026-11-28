import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MegaService } from '../mega/service.ts';

const dir = await mkdtemp(join(tmpdir(), 'boitier-mega-pause-'));
try {
  let release;
  const storage = new Promise((resolve) => { release = resolve; });
  let opened = 0;
  const events = [];
  const session = { retenir() {}, relacher() {}, async storage() { return storage; } };
  const service = new MegaService({ session, emitDownload: (e) => events.push(e), emitUpload: () => {}, fallbackDir: async () => dir });
  const req = { id: 'pause-early', accountId: 'account', fileId: 'file', name: 'video.mp4', size: 12, dir };
  const running = service.start(req);
  await new Promise((r) => setTimeout(r, 30));
  await service.pause(req.id);
  assert.ok(!events.some((e) => e.status === 'paused'), 'pause annoncée seulement après nettoyage');
  release({ files: { file: { directory: false, download() { opened++; } } } });
  await running;
  assert.equal(opened, 0, 'aucun flux ouvert après pause pendant la connexion');
  assert.equal(events.at(-1).status, 'paused');

  let release2;
  const blocked = new Promise((resolve) => { release2 = resolve; });
  session.storage = async () => blocked;
  const cancelled = service.start({ ...req, id: 'cancel-early', name: 'annule.mp4' });
  await new Promise((r) => setTimeout(r, 30));
  await service.cancel('cancel-early');
  release2({ files: { file: { directory: false, download() { opened++; } } } });
  await cancelled;
  assert.equal(opened, 0, 'aucun flux ouvert après annulation');
  assert.equal(events.at(-1).message, 'annulé');
  assert.equal(events.at(-1).cancelled, true);
  assert.ok(!(await readdir(dir)).some((name) => name.includes('annule')), 'partiel annulé supprimé');
  console.log('✔ MEGA : pause et annulation sûres pendant la préparation');
} finally { await rm(dir, { recursive: true, force: true }); }
