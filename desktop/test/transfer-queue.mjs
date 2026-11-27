import assert from 'node:assert/strict';
import { TransferQueue } from '../../src/lib/transferQueue.ts';

const calls = [], events = [];
const transport = {
  start: async (request) => { calls.push(['start', request.id, request.provider]); },
  pause: async (_provider, id) => { calls.push(['pause', id]); },
  resume: async (_provider, id) => { calls.push(['resume', id]); return true; },
  cancel: async (_provider, id) => { calls.push(['cancel', id]); },
};
const queue = new TransferQueue(transport);
queue.subscribe((e) => events.push(e));
const request = (id, provider = 'terabox') => ({ id, provider, accountId: 'account', fileId: `file-${id}`, name: `${id}.txt`, size: 12 });
const update = (id, status) => queue.observe({ id, status, received: status === 'done' ? 12 : 0, size: 12, speed: 0 });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
for (let i = 0; i < 9; i++) queue.add(request(String(i), ['terabox', 'gdrive', 'mega'][i % 3]));
await flush();
assert.deepEqual(calls.filter((c) => c[0] === 'start').map((c) => c[1]), ['0', '1', '2']);
assert.equal(events.filter((e) => e.status === 'queued').length, 9);
update('0', 'done');
await flush();
assert.deepEqual(calls.filter((c) => c[0] === 'start').map((c) => c[1]), ['0', '1', '2', '3']);
queue.pause('4'); // pas encore lancé
queue.pause('1'); // occupe une place jusqu'à l'accusé de pause
await flush();
assert.ok(calls.some((c) => c[0] === 'pause' && c[1] === '1'));
assert.equal(calls.filter((c) => c[0] === 'start').length, 4);
queue.resume('1'); // reprend seulement après confirmation de pause et si place disponible
update('1', 'paused');
await flush();
assert.deepEqual(calls.filter((c) => c[0] === 'start').map((c) => c[1]), ['0', '1', '2', '3', '5']);
queue.cancel('6');
update('2', 'done');
await flush();
assert.equal(calls.filter((c) => c[0] === 'start').at(-1)[1], '7');
queue.setLimit(1); // les transferts déjà lancés ne sont pas interrompus
update('3', 'done'); update('5', 'done');
await flush();
assert.equal(calls.some((c) => c[0] === 'start' && c[1] === '8'), false);
update('7', 'done'); await flush();
assert.ok(calls.some((c) => c[0] === 'start' && c[1] === '8'));
update('8', 'done'); await flush();
assert.ok(calls.some((c) => c[0] === 'resume' && c[1] === '1'));
update('1', 'done'); queue.resume('4'); await flush();
assert.ok(calls.some((c) => c[0] === 'start' && c[1] === '4'));
assert.equal(calls.some((c) => c[0] === 'start' && c[1] === '6'), false);

// Une pause demandée avant la fin de l'initialisation n'ouvre pas une place prématurément.
let resolve;
const held = new Promise((r) => { resolve = r; });
const raceCalls = [];
const race = new TransferQueue({ ...transport, start: async (r) => { raceCalls.push(['start', r.id]); if (r.id === 'a') await held; }, pause: async (_p, id) => { raceCalls.push(['pause', id]); } });
race.setLimit(1); race.add(request('a')); race.add(request('b')); race.pause('a');
assert.equal(raceCalls.length, 1);
race.observe({ id: 'a', status: 'running', received: 0, size: 12, speed: 0 });
await flush(); assert.deepEqual(raceCalls, [['start', 'a'], ['pause', 'a']]);
race.observe({ id: 'a', status: 'paused', received: 0, size: 12, speed: 0 });
await flush(); assert.deepEqual(raceCalls.at(-1), ['start', 'b']);
resolve(); await flush();
// Une annulation pendant l'initialisation bloque la place jusqu'à l'arrêt.
let resolveCancel;
const heldCancel = new Promise((r) => { resolveCancel = r; });
const cancelCalls = [];
const cancelQueue = new TransferQueue({ ...transport,
  start: async (r) => { cancelCalls.push(['start', r.id]); if (r.id === 'c') await heldCancel; },
  cancel: async (_p, id) => { cancelCalls.push(['cancel', id]); },
});
cancelQueue.setLimit(1); cancelQueue.add(request('c')); cancelQueue.add(request('d')); cancelQueue.cancel('c');
assert.deepEqual(cancelCalls, [['start', 'c']]);
cancelQueue.observe({ id: 'c', status: 'running', received: 0, size: 12, speed: 0 });
await flush(); assert.deepEqual(cancelCalls, [['start', 'c'], ['cancel', 'c']]);
cancelQueue.observe({ id: 'c', status: 'paused', received: 0, size: 12, speed: 0 });
await flush(); assert.equal(cancelCalls.length, 2, 'un événement pause ne libère pas une annulation en cours');
cancelQueue.observe({ id: 'c', status: 'error', received: 0, size: 12, speed: 0 });
await flush(); assert.deepEqual(cancelCalls.at(-1), ['start', 'd']);
resolveCancel(); await flush();

// Un démarrage en échec ne bloque jamais le fichier suivant.
const failures = [], failureCalls = [];
const failed = new TransferQueue({ ...transport, start: async (r) => { failureCalls.push(r.id); if (r.id === 'e') throw new Error('refus simulé'); } });
failed.subscribe((e) => failures.push(e)); failed.setLimit(1); failed.add(request('e')); failed.add(request('f'));
await flush(); await flush();
assert.deepEqual(failureCalls, ['e', 'f']);
assert.ok(failures.some((e) => e.id === 'e' && e.status === 'error' && e.message === 'refus simulé'));
// Une pause refusée ne libère pas artificiellement la place occupée.
const rejectCalls = [];
const rejectsPause = new TransferQueue({ ...transport,
  start: async (r) => { rejectCalls.push(r.id); },
  pause: async () => { throw new Error('Pause refusée'); },
});
rejectsPause.setLimit(1); rejectsPause.add(request('g')); rejectsPause.add(request('h'));
await flush(); rejectsPause.pause('g'); await flush(); await flush();
assert.deepEqual(rejectCalls, ['g']);
rejectsPause.observe({ id: 'g', status: 'done', received: 12, size: 12, speed: 0 });
await flush(); assert.deepEqual(rejectCalls, ['g', 'h']);
console.log('✔ File de transferts : limite globale, attente, pause, reprise, annulation et réglage');
