/** Tests du lanceur hors processus principal, sans installer une application. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { launchDetached } from '../update-launcher.ts';

const dir = await mkdtemp(join(tmpdir(), 'boitier-launcher-'));
try {
  const output = join(dir, 'sortie avec espaces.json');
  const script = join(dir, 'enfant avec espaces.cjs');
  await writeFile(script, `require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)))`);

  // Le worker attend délibérément : le minuteur du thread principal doit
  // continuer à tourner pendant que le lancement se prépare.
  let timerRan = false;
  let launched = false;
  const launch = launchDetached({ command: process.execPath, args: [script, output, '--updated', 'chemin avec espaces'] },
    (source, options) => new Worker(`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);\n${source}`, options));
  launch.then(() => { launched = true; });
  await new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 100));
  assert.equal(timerRan, true, 'le thread principal reste réactif');
  assert.equal(launched, false, 'le travail de lancement est encore en cours');
  await launch;
  let result;
  for (let n = 0; n < 50; n++) {
    try { result = JSON.parse(await readFile(output, 'utf8')); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.deepEqual(result, ['--updated', 'chemin avec espaces'], 'arguments transmis sans shell');
  await assert.rejects(launchDetached({ command: join(dir, 'absent.exe'), args: [] }), /ENOENT/);

  if (process.platform !== 'win32') {
    // Une élévation est un exécutable recevant le chemin original et ses
    // arguments ; ici Node joue ce rôle sans demander de privilèges.
    const elevated = join(dir, 'élevé.cjs');
    const output2 = join(dir, 'élévation.json');
    await writeFile(elevated, `require('node:fs').writeFileSync(process.argv[2], 'ok')`);
    await launchDetached({ command: elevated, args: [output2], elevationPath: process.execPath, adminRequired: true });
    for (let n = 0; n < 50; n++) {
      try { if (await readFile(output2, 'utf8') === 'ok') break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    assert.equal(await readFile(output2, 'utf8'), 'ok', 'choix élévation respecté');
  }
  console.log('✔ mise à jour : worker, réactivité, arguments, erreur et élévation vérifiés');
} finally {
  await rm(dir, { recursive: true, force: true });
}
