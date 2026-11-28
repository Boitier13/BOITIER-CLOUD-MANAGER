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
import { createWriteStream, type WriteStream } from 'node:fs';
import { link, mkdir, open, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isGoogleDocument, openExport, openMedia, readFileMeta } from './drive.ts';
import { formatExport, nomExporte } from './export.ts';
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
  /** Annulation volontaire, distincte d'un échec. */
  cancelled?: boolean;
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
  cancelled: boolean;
  /** Le flux s'est tu trop longtemps : l'abandon vient de nous, pas de Google. */
  stalled: boolean;
  /** Chemin du fichier partiel, conservé entre une pause et une reprise. */
  partPath?: string;
  /** Validateur fort associé aux octets du partiel (uniquement en mémoire). */
  validator?: string;
  validatorSize?: number;
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
export async function uniquePath(dir: string, name: string): Promise<string> {
  const base = safeFileName(name);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  let candidate = join(dir, base);
  let index = 1;
  for (;;) {
    try {
      await stat(candidate);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
      try {
        await stat(`${candidate}.part`);
      } catch (partError) {
        if ((partError as NodeJS.ErrnoException).code !== 'ENOENT') throw partError;
        return candidate;
      }
    }
    candidate = join(dir, `${stem} (${index})${ext}`);
    index += 1;
  }
}

/** Réserve aussi le partiel : deux transferts simultanés ne partagent jamais le même chemin. */
async function reservePath(dir: string, name: string): Promise<string> {
  for (;;) {
    const path = await uniquePath(dir, name);
    try {
      const file = await open(`${path}.part`, 'wx');
      await file.close();
      return path;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
    }
  }
}

export class DownloadManager {
  private readonly endpoints: Endpoints;
  private readonly jobs = new Map<string, Job>();
  private readonly emit: (event: DownloadEvent) => void;
  private readonly fallbackDir: () => Promise<string>;

  private readonly stallMs: number;
  private readonly adapter?: {
    readMeta: (accountId: string, fileId: string, signal: AbortSignal) => Promise<{ mimeType: string; size: number }>;
    openMedia: (accountId: string, fileId: string, signal: AbortSignal, from: number, validator?: string, expectedSize?: number) => Promise<Awaited<ReturnType<typeof openMedia>> & { validator?: string }>;
    /** Si activé, seule une taille exacte publie le fichier final. */
    verifySize?: boolean;
    stallProvider?: string;
  };

  constructor(
    endpoints: Endpoints,
    emit: (event: DownloadEvent) => void,
    fallbackDir: () => Promise<string>,
    options: { stallMs?: number; adapter?: DownloadManager['adapter'] } = {},
  ) {
    this.endpoints = endpoints;
    this.emit = emit;
    this.fallbackDir = fallbackDir;
    this.stallMs = options.stallMs ?? STALL_TIMEOUT_MS;
    this.adapter = options.adapter;
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
      cancelled: false,
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
    job.cancelled = false;
    job.stalled = false;
    job.status = 'running';
    job.controller = new AbortController();
    this.emit({ id, status: 'running', received: job.received, size: job.size, speed: 0 });
    void this.run(job, token);
    return true;
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.paused = false;
    job.cancelled = true;
    if (job.status === 'running') {
      job.controller.abort(); // run() ferme d'abord le fichier et annonce la fin réelle.
    } else {
      this.jobs.delete(id);
      if (job.partPath) await rm(job.partPath, { force: true }).catch(() => undefined);
      this.emit({ id, status: 'error', received: job.received, size: job.size, speed: 0, cancelled: true, message: 'Transfert annulé.' });
    }
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
    let sink: WriteStream | undefined;
    this.watch(job, timer);

    // Préparation DANS le try : un dossier impossible à créer lève ici, et
    // l'erreur doit atteindre l'interface. Elle en sortait auparavant avant le
    // `try` — la ligne restait alors « En cours » à 0 %, sans aucun message.
    try {
      const dir = relativeDir(request.dir || (await this.fallbackDir()), request.subPath);
      log(`transfert ${request.id} : dossier ${dir}`);
      await mkdir(dir, { recursive: true });
      job.controller.signal.throwIfAborted();
      // Les métadonnées décident si c'est un binaire ou un export Google.
      const meta = this.adapter
        ? await this.adapter.readMeta(token, request.fileId, job.controller.signal)
        : await readFileMeta(this.endpoints, token, request.fileId, job.controller.signal);
      job.controller.signal.throwIfAborted();
      log(`transfert ${request.id} : métadonnées ${meta.mimeType} ${meta.size} o`);
      const format = this.adapter ? undefined : formatExport(meta.mimeType);
      if (!this.adapter && isGoogleDocument(meta.mimeType) && !format) {
        throw new Error('Ce type de document Google ne possède pas encore de format d’export pris en charge.');
      }
      if (!job.partPath || !job.finalPath) {
        const nom = format ? nomExporte(safeFileName(request.name), format) : request.name;
        const finalPath = await reservePath(dir, nom);
        job.finalPath = finalPath;
        job.partPath = `${finalPath}.part`;
        if (job.controller.signal.aborted) {
          if (!job.paused) await rm(job.partPath, { force: true });
          throw new DOMException('Transfert interrompu', 'AbortError');
        }
      }
      partPath = job.partPath;
      let finalPath = job.finalPath;

      // files.export ne garantit pas Range : une reprise redémarre l'export.
      const deja = await taillePartiel(partPath);
      if (deja > 0) log(`transfert ${request.id} : partiel ${deja} o`);
      if (format) job.size = 0; // la taille source n'est pas celle de l'export
      const media = format
        ? await openExport(this.endpoints, token, request.fileId, format.mimeType, job.controller.signal)
        : this.adapter
          ? await this.adapter.openMedia(token, request.fileId, job.controller.signal, deja, job.validatorSize === meta.size ? job.validator : undefined, meta.size)
          : await openMedia(this.endpoints, token, request.fileId, job.controller.signal, deja);
      job.controller.signal.throwIfAborted();
      if (this.adapter?.verifySize) job.size = meta.size;
      else if (!job.size) job.size = media.size ?? (format ? 0 : meta.size);

      // Drive a ignoré la plage : le partiel est remplacé, jamais complété.
      if (media.resumed && media.start !== deja) throw new Error('Le serveur a répondu avec une plage de téléchargement incorrecte.');
      const reprend = media.resumed && media.start > 0;
      job.received = reprend ? media.start : 0;
      if (deja > 0 && !reprend) {
        log(`transfert ${request.id} : reprise partielle indisponible, téléchargement depuis le début`);
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

      sink = createWriteStream(partPath, { flags: reprend ? 'a' : 'w' });
      // L'erreur est également transmise par drain/end, sans événement non géré.
      sink.on('error', () => undefined);
      // Un nouveau validateur ne s'applique qu'après l'ouverture effective du
      // fichier (et sa troncature pour un redémarrage depuis zéro).
      await once(sink, 'open');
      job.validator = 'validator' in media && typeof media.validator === 'string' ? media.validator : undefined;
      job.validatorSize = job.validator ? meta.size : undefined;
      job.controller.signal.throwIfAborted();
      const reader = media.body.getReader();
      const startedAt = Date.now();
      let lastEmit = 0;
      let lastBytes = job.received;

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
        sink!.end((error?: Error | null) => (error ? reject(error) : resolve()));
      });

      job.controller.signal.throwIfAborted();
      if (this.adapter?.verifySize && job.received !== meta.size) {
        throw new Error('Téléchargement incomplet : la taille reçue ne correspond pas au fichier source.');
      }

      // link est atomique et refuse d'écraser un fichier créé entre-temps.
      for (;;) {
        try {
          await link(partPath, finalPath);
          break;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
          const next = await reservePath(dirname(finalPath), basename(finalPath));
          await rm(`${next}.part`, { force: true });
          finalPath = next;
        }
      }
      await rm(partPath, { force: true });
      // Plus de partiel : une annulation tardive ne doit pas viser un chemin mort.
      job.partPath = undefined;
      job.status = 'done';
      log(`transfert ${request.id} : terminé (${job.received} o) → ${finalPath}`);
      const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      this.emit({
        id: request.id,
        name: format ? basename(finalPath) : request.name,
        status: 'done',
        received: job.received,
        size: format ? job.received : job.size || job.received,
        speed: Math.round(job.received / seconds),
        path: finalPath,
      });
    } catch (cause) {
      // Fermer le handle avant d'autoriser une reprise (notamment sur Windows).
      if (sink && !sink.closed) {
        const closed = once(sink, 'close').catch(() => undefined);
        sink.destroy();
        await closed;
      }
      if (job.cancelled) {
        if (job.partPath) await rm(job.partPath, { force: true }).catch(() => undefined);
        if (this.jobs.get(request.id) === job) this.jobs.delete(request.id);
        this.emit({ id: request.id, status: 'error', received: job.received, size: job.size, speed: 0, cancelled: true, message: 'Transfert annulé.' });
        return;
      }
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
        ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '')
          ? 'Ce disque ne permet pas de finaliser le fichier sans risque d’écrasement. Choisissez un disque compatible dans Paramètres.'
          : code === 'ENOENT'
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
              : `${this.adapter?.stallProvider ?? 'Google'} n’a envoyé aucune donnée en ${seconds} s. Vérifiez la connexion puis réessayez.`,
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
