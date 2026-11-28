import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../google/vault.ts';
import { MegaVault } from '../mega/store.ts';
import { ShadowVault } from '../shadow/vault.ts';
import { TeraBoxVault } from '../terabox/vault.ts';
import { TeraBoxService } from '../terabox/service.ts';

const dir = await mkdtemp(join(tmpdir(), 'boitier-coexistence-'));
try {
  const encrypt = (s) => Buffer.from(`test:${s}`).reverse();
  const decrypt = (b) => Buffer.from(b).reverse().toString().slice(5);
  const google = new Vault(dir, encrypt, decrypt);
  await google.update((v) => { v.accounts.push({ id: 'g', name: 'G', email: 'same@example.test', status: 'connected', usedBytes: 1, quotaBytes: 2, createdAt: '2026-01-01', tokens: { accessToken: 'google-secret', expiresAt: 1 } }); });
  const mega = new MegaVault(dir, encrypt, decrypt);
  await mega.write([{ id: 'm', name: 'M', email: 'same@example.test', addedAt: '2026-01-01', session: { sid: 'mega-secret', key: 'key', name: 'M', user: 'm' } }]);
  const shadow = new ShadowVault(dir, encrypt, decrypt);
  await shadow.change(() => [{ id: 's', name: 'S', username: 'same@example.test', url: 'https://drive.shadow.tech/', token: 'shadow-secret', usedBytes: 1, quotaBytes: 2 }]);
  const names = ['google-accounts.enc', 'mega-sessions.enc', 'shadow-accounts.enc'];
  const before = await Promise.all(names.map((n) => readFile(join(dir, n))));
  const fakeReader = (session) => ({ identity: async () => session === 'fake-session-one' ? '1' : '2', quota: async () => ({ usedBytes: 1, quotaBytes: 10 }), list: async () => [], search: async () => [] });
  const terabox = new TeraBoxService(new TeraBoxVault(dir, encrypt, decrypt), fetch, fakeReader);
  await terabox.connect('fake-session-one', 'same@example.test');
  await terabox.connect('fake-session-two', 'other@example.test');
  assert.equal((await terabox.accounts()).length, 2);
  await terabox.disconnect('terabox-1');
  assert.deepEqual(await Promise.all(names.map((n) => readFile(join(dir, n)))), before, 'les coffres des autres fournisseurs ne sont pas modifiés');
  assert.equal((await new Vault(dir, encrypt, decrypt).read()).accounts[0].email, 'same@example.test');
  assert.equal((await new MegaVault(dir, encrypt, decrypt).read())[0].email, 'same@example.test');
  assert.equal((await new ShadowVault(dir, encrypt, decrypt).accounts())[0].username, 'same@example.test');
  assert.deepEqual((await new TeraBoxVault(dir, encrypt, decrypt).accounts()).map((a) => a.id), ['terabox-2']);
  console.log('✔ Cohabitation : les quatre coffres restent indépendants');
} finally { await rm(dir, { recursive: true, force: true }); }
