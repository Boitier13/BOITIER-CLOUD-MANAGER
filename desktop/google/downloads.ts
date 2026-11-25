/**
 * Téléchargement réel d'un fichier Drive vers le disque local.
 *
 * Écrit dans un fichier `.part` puis renomme à la fin : un transfert
 * interrompu ne laisse jamais de fichier tronqué présenté comme complet.
 * La pause annule le flux réseau ; la reprise repart du début (Drive ne
 * garantit pas de plage `Range` sur `alt=media`).
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isGoogleDocument, openMedia, readFileMeta } from './drive.ts';
import type { Endpoints } from './endpoints.ts';

export type DownloadStatus = 'running' | 'paused' | 'done' | 'error';

export interface DownloadEvent {
  id: string;
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
}

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

  constructor(
    endpoints: Endpoints,
    emit: (event: DownloadEvent) => void,
    fallbackDir: () => Promise<string>,
  ) {
    this.endpoints = endpoints;
    this.emit = emit;
    this.fallbackDir = fallbackDir;
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
    const job: Job = {
      request,
      controller: new AbortController(),
      received: 0,
      size: request.size,
      status: 'running',
      paused: false,
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

  async resume(id: string, token: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'paused') return false;
    job.paused = false;
    job.status = 'running';
    job.received = 0;
    job.controller = new AbortController();
    this.emit({ id, status: 'running', received: 0, size: job.size, speed: 0 });
    void this.run(job, token);
    return true;
  }

  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.paused = false;
    job.controller.abort();
    this.jobs.delete(id);
  }

  private async run(job: Job, token: string): Promise<void> {
    const { request } = job;
    const dir = relativeDir(request.dir || (await this.fallbackDir()), request.subPath);
    await mkdir(dir, { recursive: true });
    const finalPath = await uniquePath(dir, request.name);
    const partPath = `${finalPath}.part`;

    try {
      // Documents Google natifs (Docs, Sheets…) : pas de flux binaire direct.
      const meta = await readFileMeta(this.endpoints, token, request.fileId, job.controller.signal);
      if (isGoogleDocument(meta.mimeType)) {
        throw new Error(
          'Les documents Google natifs (Docs, Sheets, Slides) n’ont pas de fichier binaire. Exportez-les d’abord depuis Google Drive.',
        );
      }

      const media = await openMedia(this.endpoints, token, request.fileId, job.controller.signal);
      if (!job.size) job.size = media.size ?? meta.size;

      const sink = createWriteStream(partPath);
      const reader = media.body.getReader();
      const startedAt = Date.now();
      let lastEmit = 0;
      let lastBytes = 0;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        job.received += value.length;
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
      job.status = 'done';
      const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      this.emit({
        id: request.id,
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
      await rm(partPath, { force: true }).catch(() => undefined);

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
        status: 'error',
        received: job.received,
        size: job.size,
        speed: 0,
        message: (cause as Error).message || 'Téléchargement interrompu.',
      });
    }
  }
}
