/**
 * Point d'entrée du processus principal.
 *
 * Rôle unique : ouvrir le journal **avant** que le reste du code soit chargé,
 * puis céder la place. Sans cette couche, un échec au chargement d'un module
 * (dépendance absente, initialisation qui lève) arrêtait le processus sans une
 * ligne de journal et sans fenêtre : l'application semblait ne pas démarrer,
 * et rien ne permettait de le prouver.
 *
 * `require('./main.ts')` volontaire, après l'ouverture du journal : esbuild
 * insère le module applicatif **à cet endroit**, donc après l'initialisation de
 * la trace.
 */

import { app, dialog } from 'electron';
import { initLog, log, logPath } from './log.ts';
import { resolveDataDir } from './paths.ts';

try {
  initLog(resolveDataDir(app.getPath('appData')));
} catch {
  /* disque inaccessible : on continuera sans journal plutôt que de mourir */
}

/**
 * Dernier filet : une exception non rattrapée est écrite dans le journal **et**
 * montrée à l'utilisateur, même sans fenêtre. Une fenêtre invisible et un
 * processus mort sans trace sont les deux pires états possibles.
 */
function reportFatal(origin: string, cause: unknown): void {
  const detail =
    cause instanceof Error
      ? `${cause.name} : ${cause.message}\n${String(cause.stack ?? '').split('\n').slice(0, 8).join('\n')}`
      : String(cause);
  log(`échec (${origin}) : ${detail.replace(/\n/g, ' | ')}`);
  try {
    dialog.showErrorBox(
      'BOITIER CLOUD MANAGER n’a pas pu démarrer',
      `${detail}\n\nJournal : ${logPath() ?? 'indisponible'}`,
    );
  } catch {
    /* même la boîte de dialogue échoue : le journal reste la trace */
  }
}

process.on('uncaughtException', (cause) => reportFatal('exception', cause));
process.on('unhandledRejection', (cause) => reportFatal('promesse rejetée', cause));

log(
  `processus démarré · ${app.getVersion()} · ` +
    `${app.isPackaged ? 'installée' : 'développement'} · Electron ${process.versions.electron}`,
);

// À partir d'ici seulement, le code applicatif est chargé.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('./main.ts');
