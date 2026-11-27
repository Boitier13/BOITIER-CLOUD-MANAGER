/**
 * Lancer un processus peut bloquer dans Windows (analyse antivirus, accès disque).
 * Le faire dans un worker évite de suspendre le processus principal d'Electron.
 * On attend l'événement `spawn` avant de fermer l'application : une erreur de
 * lancement doit laisser la fenêtre utilisable et permettre une nouvelle tentative.
 */
import { Worker, type WorkerOptions } from 'node:worker_threads';

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
function start(command, args, mayElevate) {
  let child;
  try {
    child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
  } catch (error) { return failure(error, mayElevate); }
  child.once('error', error => failure(error, mayElevate));
  child.once('spawn', () => {
    child.unref();
    parentPort.postMessage({ ok: true });
    parentPort.close();
  });
}
function failure(error, mayElevate) {
  if (mayElevate && workerData.elevationPath && ['EACCES', 'UNKNOWN'].includes(error.code)) {
    start(workerData.elevationPath, [workerData.command, ...workerData.args], false);
  } else {
    parentPort.postMessage({ ok: false, code: error.code || 'UNKNOWN' });
    parentPort.close();
  }
}
if (workerData.adminRequired && workerData.elevationPath) {
  start(workerData.elevationPath, [workerData.command, ...workerData.args], false);
} else {
  start(workerData.command, workerData.args, true);
}
`;

export interface LaunchOptions {
  command: string;
  args: string[];
  elevationPath?: string;
  adminRequired?: boolean;
}

export function launchDetached(
  options: LaunchOptions,
  makeWorker: (source: string, options: WorkerOptions) => Worker = (source, config) => new Worker(source, config),
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = makeWorker(WORKER_SOURCE, { eval: true, workerData: options });
    worker.once('message', (message: { ok: boolean; code?: string }) => {
      settled = true;
      if (message.ok) resolve();
      else reject(new Error(`Lancement impossible (${message.code ?? 'UNKNOWN'}).`));
    });
    worker.once('error', (error) => {
      if (!settled) { settled = true; reject(error); }
    });
    worker.once('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`Lanceur arrêté (${code}).`)); }
    });
  });
}
