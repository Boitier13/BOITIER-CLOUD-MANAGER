/**
 * Téléchargement réel d'un fichier Drive vers le disque local.
 *
 * Écrit dans un fichier `.part` puis renomme à la fin : un transfert
 * interrompu ne laisse jamais de fichier tronqué présenté comme complet.
 *
 * **La pause conserve le fichier partiel**, et la reprise demande à Drive la
 * suite exacte avec `Range: bytes=<n>-`. C'est ce qui évite de retélécharger
 * 148 Mo parce qu'une connexion a sauté à 90 %. Si Drive ignorait la plage
 * (réponse `200` au lieu de `206`), le partiel est **remplacé** et non
 * complété : ajouter le fichier entier à la suite produirait un fichier
 * corrompu de taille double.
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isGoogleDocument, openMedia, readFileMeta } from './drive.ts';
import type { Endpoints } from './endpoints.ts';
import { log } from '../log.ts';

export type DownloadStatus = 'running' | 'paused' | 'done' | 'error';

export interface DownloadEvent {
  id: string;
  /** Nom du fichier : la notification système doit pouvoir le nommer. */
  name?: string;
  status: DownloadStatus;
  received: number;
  size: number;
  speed: number;
  path?: string;
  message?: string;
}

export interface DownloadRequest {
  id: string;
  fileId: string;
  name: string;
  size: number;
  dir: string;
  /**
   * Sous-dossier relatif à `dir`, pour un téléchargement de dossier entier :
   * chaque fichier conserve son emplacement d'origine dans l'arborescence.
   */
  subPath?: string;
}

interface Job {
  request: DownloadRequest;
  controller: AbortController;
  received: number;
  size: number;
  status: DownloadStatus;
  paused: boolean;
  /** Le flux s'est tu trop longtemps : l'abandon vient de nous, pas de Google. */
  stalled: boolean;
  /** Chemin du fichier partiel, conservé entre une pause et une reprise. */
  partPath?: string;
  /** Chemin final, calculé une seule fois (les « (1) » ne doivent pas changer). */
  finalPath?: string;
}

/**
 * Délai sans le moindre octet avant d'abandonner.
 *
 * Un flux bloqué laissait une ligne « En cours » à 0 % indéfiniment : impossible
 * de distinguer une attente lente d'un échec. Vingt secondes suffisent pour une
 * réponse de Google, même sur un gros fichier.
 */
const STALL_TIMEOUT_MS = 20_000;

/**
 * Chemin de destination d'une entrée de dossier téléchargé.
 *
 * Chaque segment est assaini séparément : un nom de dossier Drive peut contenir
 * des caractères que Windows refuse, et rien ne doit permettre de sortir du
 * dossier choisi (ni `..` ni chemin absolu).
 */
export function relativeDir(root: string, subPath: string | undefined): string {
  if (!subPath) return root;
  const parts = subPath
    .split('/')
    // On écarte d'abord les segments de remontée, avant l'assainissement :
    // `safeFileName('..')` les remplacerait par un nom neutre au lieu de les
    // supprimer, et un dossier Drive nommé « .. » ne doit pas créer de niveau.
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => safeFileName(part));
  return join(root, ...parts);
}

/** Noms sûrs : pas de séparateur de chemin ni de caractère interdit. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 180) || 'fichier';
}

/** Taille d'un fichier, ou 0 s'il n'existe pas encore. */
async function taillePartiel(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return Number.isFinite(info.size) && info.size > 0 ? info.size : 0;
  } catch {
    return 0;
  }
}

/** Ajoute « (1) », « (2) »… plutôt que d'écraser un fichier existant. */
async function uniquePath(dir: string, name: string): Promise<string> {
  const base = safeFileName(name);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let candidate = join(dir, base);
  let index = 1;
  for (;;) {
    try {
      await stat(candidate);
      candidate = join(dir, `${stem} (${index})${ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

export class DownloadManager {
  private readonly endpoints: Endpoints;
  private readonly jobs = new Map<string, Job>();
  private readonly emit: (event: DownloadEvent) => void;
  private readonly fallbackDir: () => Promise<string>;

  private readonly stallMs: number;

  constructor(
    endpoints: Endpoints,
    emit: (event: DownloadEvent) => void,
    fallbackDir: () => Promise<string>,
    options: { stallMs?: number } = {},
  ) {
    this.endpoints = endpoints;
    this.emit = emit;
    this.fallbackDir = fallbackDir;
    this.stallMs = options.stallMs ?? STALL_TIMEOUT_MS;
  }

  list(): { id: string; status: DownloadStatus; received: number; size: number }[] {
    return [...this.jobs.values()].map((job) => ({
      id: job.request.id,
      status: job.status,
      received: job.received,
      size: job.size,
    }));
  }

  async start(request: DownloadRequest, token: string): Promise<void> {
    // Même identifiant qu'un transfert suspendu ou en échec : c'est une reprise,
    // pas un nouveau téléchargement. Sans cela, « Réessayer » repartait de zéro
    // dans un second fichier, en laissant le partiel orphelin sur le disque.
    const existant = this.jobs.get(request.id);
    if (existant && (existant.status === 'paused' || existant.status === 'error')) {
      log(`transfert ${request.id} : reprise demandée (${existant.status})`);
      if (await this.resume(request.id, token)) return;
    }

    const job: Job = {
      request,
      controller: new AbortController(),
      received: 0,
      size: request.size,
      status: 'running',
      paused: false,
      stalled: false,
    };
    this.jobs.set(request.id, job);
    // Émission immédiate : l'interface affiche le transfert sans attendre le
    // premier paquet (utile pour les petits fichiers).
    this.emit({
      id: request.id,
      status: 'running',
      received: 0,
      size: request.size,
      speed: 0,
    });
    void this.run(job, token);
  }

  pause(id: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return;
    job.paused = true;
    job.controller.abort();
  }

  /**
   * Reprend là où le transfert s'est arrêté.
   *
   * Accepté aussi après un échec réseau : le fichier partiel est encore là, et
   * l'utilisateur qui clique « Reprendre » ne s'attend pas à repayer 90 % du
   * téléchargement. Le nombre d'octets déjà reçus n'est pas remis à zéro : il
   * sera recalculé sur la taille réelle du partiel au moment de repartir.
   */
  async resume(id: string, token: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'paused' && job.status !== 'error')) return false;
    job.paused = false;
    job.stalled = false;
    job.status = 'running';
    job.controller = new AbortController();
    this.emit({ id, status: 'running', received: job.received, size: job.size, speed: 0 });
    void this.run(job, token);
    return true;
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.paused = false;
    job.controller.abort();
    this.jobs.delete(id);
    // Seule l'annulation efface le partiel : une pause doit permettre de reprendre.
    if (job.partPath) void rm(job.partPath, { force: true }).catch(() => undefined);
  }

  /** Abandonne le transfert si le flux reste muet plus de `stallMs`. */
  private watch(job: Job, timer: { handle?: NodeJS.Timeout }): void {
    if (timer.handle) clearTimeout(timer.handle);
    timer.handle = setTimeout(() => {
      job.stalled = true;
      job.controller.abort();
    }, this.stallMs);
  }

  private async run(job: Job, token: string): Promise<void> {
    const { request } = job;
    const timer: { handle?: NodeJS.Timeout } = {};
    // Déclaré hors du `try` : le nettoyage en cas d'échec doit y accéder.
    let partPath = '';
    this.watch(job, timer);

    // Préparation DANS le try : un dossier impossible à créer lève ici, et
    // l'erreur doit atteindre l'interface. Elle en sortait auparavant avant le
    // `try` — la ligne restait alors « En cours » à 0 %, sans aucun message.
    try {
      if (!job.partPath || !job.finalPath) {
        const dir = relativeDir(request.dir || (await this.fallbackDir()), request.subPath);
        log(`transfert ${request.id} : dossier ${dir}`);
        await mkdir(dir, { recursive: true });
        const finalPath = await uniquePath(dir, request.name);
        job.finalPath = finalPath;
        job.partPath = `${finalPath}.part`;
      }
      partPath = job.partPath;
      const finalPath = job.finalPath;

      // Documents Google natifs (Docs, Sheets…) : pas de flux binaire direct.
      const meta = await readFileMeta(this.endpoints, token, request.fileId, job.controller.signal);
      log(`transfert ${request.id} : métadonnées ${meta.mimeType} ${meta.size} o`);
      if (isGoogleDocument(meta.mimeType)) {
        throw new Error(
          'Les documents Google natifs (Docs, Sheets, Slides) n’ont pas de fichier binaire. Exportez-les d’abord depuis Google Drive.',
        );
      }

      // Octets réellement présents sur le disque : c'est la vérité, pas le
      // compteur en mémoire — une fermeture brutale laisserait un partiel plus
      // court que ce que l'interface croyait avoir reçu.
      const deja = await taillePartiel(partPath);
      if (deja > 0) log(`transfert ${request.id} : reprise à ${deja} o`);

      const media = await openMedia(
        this.endpoints,
        token,
        request.fileId,
        job.controller.signal,
        deja,
      );
      if (!job.size) job.size = media.size ?? meta.size;

      // Drive a ignoré la plage : le partiel est remplacé, jamais complété.
      const reprend = media.resumed && media.start > 0;
      job.received = reprend ? media.start : 0;
      if (deja > 0 && !reprend) {
        log(`transfert ${request.id} : plage refusée, reprise depuis le début`);
      }
      log(
        `transfert ${request.id} : flux ouvert, ${job.size} o annoncés` +
          (reprend ? ` (reprise à ${job.received} o)` : ''),
      );
      this.emit({
        id: request.id,
        status: 'running',
        received: job.received,
        size: job.size,
        speed: 0,
      });

      const sink = createWriteStream(partPath, { flags: reprend ? 'a' : 'w' });
      const reader = media.body.getReader();
      const startedAt = Date.now();
      let lastEmit = 0;
      let lastBytes = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        if (!job.received) log(`transfert ${request.id} : premier paquet (${value.length} o)`);
        job.received += value.length;
        this.watch(job, timer);
        if (!sink.write(Buffer.from(value))) await once(sink, 'drain');

        const now = Date.now();
        if (now - lastEmit > 200) {
          const speed = ((job.received - lastBytes) * 1000) / Math.max(now - lastEmit, 1);
          lastBytes = job.received;
          lastEmit = now;
          this.emit({
            id: request.id,
            status: 'running',
            received: job.received,
            size: job.size,
            speed: Math.round(speed),
          });
        }
      }

      await new Promise<void>((resolve, reject) => {
        sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });

      await rename(partPath, finalPath);
      // Plus de partiel : une annulation tardive ne doit pas viser un chemin mort.
      job.partPath = undefined;
      job.status = 'done';
      log(`transfert ${request.id} : terminé (${job.received} o) → ${finalPath}`);
      const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      this.emit({
        id: request.id,
        name: request.name,
        status: 'done',
        received: job.received,
        size: job.size || job.received,
        speed: Math.round(job.received / seconds),
        path: finalPath,
      });
    } catch (cause) {
      const aborted =
        (cause as Error).name === 'AbortError' ||
        (cause as { code?: string }).code === 'ABORT_ERR';
      // Le partiel n'est **pas** supprimé ici : une pause doit pouvoir reprendre,
      // et un échec réseau aussi — l'utilisateur ne doit pas repayer les octets
      // déjà reçus. Seule l'annulation efface le fichier.

      if (!job.stalled && !aborted) {
        log(`transfert ${request.id} : échec — ${(cause as Error).message}`);
      }

      // Message lisible pour les refus du disque (chemin inexistant, droits…).
      const code = (cause as { code?: string }).code;
      const diskMessage =
        code === 'ENOENT'
          ? `Dossier introuvable : « ${request.dir} ». Choisissez un autre dossier dans Paramètres.`
          : code === 'EACCES' || code === 'EPERM'
            ? `Windows refuse l’écriture dans « ${request.dir} ». Choisissez un autre dossier dans Paramètres.`
            : code === 'ENOSPC'
              ? 'Le disque est plein : impossible de poursuivre le transfert.'
              : '';

      if (job.stalled) {
        const seconds = Math.max(1, Math.round(this.stallMs / 1000));
        job.status = 'error';
        this.emit({
          id: request.id,
          name: request.name,
          status: 'error',
          received: job.received,
          size: job.size,
          speed: 0,
          message:
            job.received > 0
              ? `Flux interrompu : plus aucune donnée depuis ${seconds} s (${job.received} o reçus).`
              : `Google n’a envoyé aucune donnée en ${seconds} s. Vérifiez la connexion puis réessayez.`,
        });
        return;
      }

      if (aborted && job.paused) {
        job.status = 'paused';
        this.emit({
          id: request.id,
          status: 'paused',
          received: job.received,
          size: job.size,
          speed: 0,
        });
        return;
      }

      job.status = 'error';
      this.emit({
        id: request.id,
        name: request.name,
        status: 'error',
        received: job.received,
        size: job.size,
        speed: 0,
        message: diskMessage || (cause as Error).message || 'Téléchargement interrompu.',
      });
    } finally {
      if (timer.handle) clearTimeout(timer.handle);
    }
  }
}
