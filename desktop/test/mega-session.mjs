/** Tests comportementaux hors réseau : cycle de vie et file des sessions. */
import assert from 'node:assert/strict';
import { Storage } from 'megajs';
import { MegaSession } from '../mega/session.ts';
import { messageErreurMega } from '../mega/files.ts';
import { SerialQueue } from '../../src/lib/serialQueue.ts';

const makeAccount = (id) => ({ id, email: `${id}@test.invalid`, name: id,
  session: { user: id, name: id, sid: `sid-${id}`, key: 'key' },
  addedAt: '2020-01-01', usedBytes: 15, quotaBytes: 20 });
let accounts = ['a', 'b', 'c'].map(makeAccount);
const vault = { async read() { return structuredClone(accounts); }, async write(value) { accounts = structuredClone(value); } };
const instances = [];
let makeFailure = null;
function instance(id, sid, isNew = false) {
  const storage = {
    user: id, name: id, sid, status: 'ready',
    api: { closed: false, close() { this.closed = true; } },
    ready: makeFailure ? Promise.reject(makeFailure) : Promise.resolve(),
    async reload() {},
    async close() { throw new Error('logout interdit pendant une libération'); },
    toJSON() { return { user: id, name: id, sid, key: 'key' }; },
    async getAccountInfo() { throw new Error('le quota ne doit pas bloquer la connexion'); },
  };
  instances.push(storage);
  return storage;
}
const create = (options) => instance(options.email.split('@')[0], 'nouveau-sid', true);
const restore = (data) => instance(data.user, data.sid);
const session = new MegaSession(vault, create, restore);
const a = await session.storage('a');
const b = await session.storage('b');
session.retenir('a');
await session.storage('c');
assert.equal(a.api.closed, false, 'session en cours d’utilisation protégée');
assert.equal(b.api.closed, true, 'libération locale de la session la moins récente');
assert.equal(accounts.find((x) => x.id === 'b').session.sid, 'sid-b');
const b2 = await session.storage('b');
assert.equal(b2.sid, 'sid-b', 'restauration avec la même session après éviction');
session.relacher('a');
await session.closeAll();
assert.ok(instances.every((s) => s.api.closed), 'fermeture locale au quit, sans logout');
const afterRestart = new MegaSession(vault, create, restore);
assert.equal((await afterRestart.storage('b')).sid, 'sid-b');
const reconnected = await afterRestart.connect('a@test.invalid', 'secret');
assert.equal(reconnected.usedBytes, 15, 'quota précédent conservé');
assert.equal(accounts.find((x) => x.id === 'a').session.sid, 'nouveau-sid');
assert.equal(accounts.find((x) => x.id === 'a').addedAt, '2020-01-01');
makeFailure = new Error('invalid credentials');
await assert.rejects(afterRestart.connect('a@test.invalid', 'secret'), /mot de passe MEGA incorrect/);
assert.equal(accounts.find((x) => x.id === 'a').session.sid, 'nouveau-sid', 'un échec ne détruit pas la session enregistrée');
makeFailure = new Error('EBLOCKED (-16): User blocked');
await assert.rejects(afterRestart.connect('a@test.invalid', 'secret'), /compte est bloqué/);
makeFailure = new Error('EMFAREQUIRED (-26)');
await assert.rejects(afterRestart.connect('a@test.invalid', 'secret'), /deux étapes/);
assert.match(messageErreurMega(new Error('mysterious token=secret')), /raison inconnue/);
assert.doesNotMatch(messageErreurMega(new Error('mysterious token=secret')), /secret/);
await afterRestart.closeAll();

// Utilise aussi l'objet megajs réel : aucune requête « sml » ne doit partir.
let appels = 0;
const vraieSession = Storage.fromJSON({
  key: Buffer.alloc(16).toString('base64url'), sid: 'test-sid', name: 'a', user: 'a',
  options: { email: 'a@test.invalid', password: '', autoload: false, autologin: false, keepalive: false },
});
vraieSession.api.fetch = async () => { appels++; throw new Error('réseau interdit'); };
vraieSession.reload = async () => [];
const vraiCycle = new MegaSession(vault, create, () => vraieSession);
await vraiCycle.storage('a');
await vraiCycle.closeAll();
assert.equal(appels, 0, 'megajs ne reçoit aucune demande de déconnexion serveur');
assert.equal(vraieSession.api.closed, true);

let release;
const started = [];
let inFlight = 0, maxInFlight = 0;
const queue = new SerialQueue(async (id) => {
  started.push(id); inFlight++; maxInFlight = Math.max(inFlight, maxInFlight);
  if (id === 'a') await new Promise((resolve) => { release = resolve; });
  inFlight--;
  if (id === 'b') throw new Error('test');
}, async () => {});
queue.ajouter('a'); queue.ajouter('a'); queue.ajouter('b'); queue.ajouter('c');
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(started, ['a'], 'la tâche suivante attend même si la première est longue');
release();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(started, ['a', 'b', 'c'], 'déduplication et poursuite après erreur');
assert.equal(maxInFlight, 1);
console.log('✔ MEGA : cycle de session, reconnexion, erreurs et file série vérifiés');
