/** La copie expérimentale ne partage ni son dossier local ni ses mises à jour. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { isTeraBoxTestBuild, resolveDataDir } from '../paths.ts';

const original = process.env.BOITIER_TERABOX_TEST_BUILD;
try {
  delete process.env.BOITIER_TERABOX_TEST_BUILD;
  assert.equal(isTeraBoxTestBuild(), false);
  assert.equal(resolveDataDir('base'), join('base', 'BOITIER CLOUD MANAGER'));
  process.env.BOITIER_TERABOX_TEST_BUILD = '1';
  assert.equal(isTeraBoxTestBuild(), true);
  assert.equal(resolveDataDir('base'), join('base', 'BOITIER CLOUD MANAGER - TEST TERABOX'));
  const boot = await readFile(new URL('../boot.ts', import.meta.url), 'utf8');
  const updater = await readFile(new URL('../updater.ts', import.meta.url), 'utf8');
  const workflow = await readFile(new URL('../../.github/workflows/terabox-test.yml', import.meta.url), 'utf8');
  assert.match(boot, /mkdirSync\(testDataDir, \{ recursive: true \}\)/);
  assert.match(boot, /app\.setPath\('userData', testDataDir\)/);
  assert.match(updater, /!app\.isPackaged \|\| isTeraBoxTestBuild\(\) \|\| this\.wired/);
  assert.match(updater, /if \(isTeraBoxTestBuild\(\)\) return this\.snapshot\(\)/);
  assert.match(workflow, /com\.boitier\.cloudmanager\.teraboxtest/);
  assert.match(workflow, /BOITIER_TERABOX_TEST_BUILD: '1'/);
  assert.match(workflow, /--publish never/);
  console.log('✔ Version test TeraBox : profil isolé et mises à jour désactivées');
} finally {
  if (original === undefined) delete process.env.BOITIER_TERABOX_TEST_BUILD;
  else process.env.BOITIER_TERABOX_TEST_BUILD = original;
}
