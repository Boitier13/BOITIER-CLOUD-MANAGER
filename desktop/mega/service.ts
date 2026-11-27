/**
 * MEGA côté processus principal : lecture, téléchargement, téléversement.
 *
 * Le fournisseur est volontairement isolé de Google : rien ici ne connaît
 * Drive, et `desktop/google/` ne connaît pas MEGA. Les deux produisent les mêmes
 * formes de données (`RemoteFile`, `DownloadEvent`), ce qui permet à
 * l'interface de rester identique quel que soit le compte.
 *
 * Les téléchargements écrivent un `.part` puis renomment : un transfert
 * interrompu ne laisse jamais un fichier tronqué présenté comme complet. La
 * pause conserve le partiel, et la reprise demande à MEGA la suite
 * (`start`), pour la même raison que côté Drive : on ne repaie pas 90 % d'un
 * fichier parce que la connexion a sauté.
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline, Transform } from 'node:stream';
import type { DownloadEvent, DownloadStatus } from '../google/downloads.ts';
import { relativeDir, safeFileName, uniquePath } from '../google/downloads.ts';
import { log } from '../log.ts';
import {
  messageErreurMega,
  mimeFromName,
  sessionExpiree,
  sortRemoteFiles,
  toRemoteFile,
  type RemoteFile,
} from './files.ts';
import type { MegaSession } from './session.ts';

/** Progression d'un téléversement (forme propre, l'interface a sa file). */
export interface UploadEvent {
  id: string;
  accountId: string;
  name: string;
  status: DownloadStatus;
  received: number;
  size: number;
  message?: string;
}

export interface MegaDownloadRequest {
  id: string;
  accountId: string;
  fileId: string;
  name: string;
  size: number;
  dir: string;
  subPath?: string;
}

interface Job {
  request: MegaDownloadRequest;
  status: DownloadStatus;
  received: number;
  size: number;
  paused: boolean;
  /** Abandonne le flux en cours (pause, annulation). */
  stopper?: () => void;
  partPath?: string;
  finalPath?: string;
}

/** Silence toléré sans un octet avant d'abandonner un transfert. */
const SILENCE_MAX_MS = 60_000;

export class MegaService {
  /** Exposée pour la fermeture propre de l'application. */
  readonly session: MegaSession;
  private readonly emitDownload: (event: DownloadEvent) => void;
  private readonly emitUpload: (event: UploadEvent) => void;
  private readonly fallbackDir: () => Promise<string>;
  private readonly jobs = new Map<string, Job>();
  private compteur = 0;

  constructor(options: {
    session: MegaSession;
    emitDownload: (event: DownloadEvent) => void;
    emitUpload: (event: UploadEvent) => void;
    fallbackDir: () => Promise<string>;
  }) {
    this.session = options.session;
    this.emitDownload = options.emitDownload;
    this.emitUpload = options.emitUpload;
    this.fallbackDir = options.fallbackDir;
  }

  /** Contenu d'un dossier (`folderId` vide = racine du compte). */
  async list(accountId: string, folderId: string): Promise<RemoteFile[]> {
    this.session.retenir(accountId);
    try {
      const storage = await this.session.storage(accountId);
      const dossier = folderId ? storage.files[folderId] : storage.root;
      if (!dossier) throw new Error('dossier MEGA introuvable');
      const enfants = dossier.children ?? [];
      return sortRemoteFiles(
        enfants.map((enfant) => toRemoteFile(enfant, dossier.nodeId ?? (folderId || undefined))),
      );
    } finally {
      this.session.relacher(accountId);
    }
  }

  /** Derniers fichiers modifiés du compte (MEGA ne transmet pas d'ouverture). */
  async recent(accountId: string, limit = 200): Promise<RemoteFile[]> {
    this.session.retenir(accountId);
    try {
      const storage = await this.session.storage(accountId);
      const fichiers = Object.values(storage.files)
        .filter((nœud) => !nœud.directory)
        .map((nœud) => toRemoteFile(nœud, nœud.parent?.nodeId));
      fichiers.sort((a, b) => (a.modified < b.modified ? 1 : -1));
      return fichiers.slice(0, Math.max(1, Math.min(limit, 500)));
    } finally {
      this.session.relacher(accountId);
    }
  }

  /**
   * Recherche par nom, dans tout le compte.
   *
   * MEGA ne propose pas de recherche serveur : tout est déjà en mémoire après
   * la lecture de l'arborescence, la recherche est donc locale et instantanée.
   */
  async search(accountId: string, term: string): Promise<RemoteFile[]> {
    this.session.retenir(accountId);
    try {
      const requete = term.trim().toLowerCase();
      if (requete.length < 2) return [];
      const storage = await this.session.storage(accountId);
      const trouves = Object.values(storage.files)
        .filter((nœud) => (nœud.name ?? '').toLowerCase().includes(requete))
        .slice(0, 200)
        .map((nœud) => toRemoteFile(nœud, nœud.parent?.nodeId));
      return sortRemoteFiles(trouves);
    } finally {
      this.session.relacher(accountId);
    }
  }

  /**
   * Parcourt un dossier et renvoie le plan de téléchargement, sans rien écrire.
   *
   * Même forme que côté Google : l'interface affiche le même dialogue, avec le
   * nombre de fichiers, les sous-dossiers et la taille totale avant de lancer
   * quoi que ce soit.
   */
  async plan(
    accountId: string,
    folderId: string,
  ): Promise<{
    files: { fileId: string; path: string; size: number; mimeType: string }[];
    folders: string[];
    skipped: string[];
    truncated: boolean;
    totalBytes: number;
  }> {
    this.session.retenir(accountId);
    try {
      const storage = await this.session.storage(accountId);
      const racine = folderId ? storage.files[folderId] : storage.root;
      if (!racine) throw new Error('dossier MEGA introuvable');

      const fichiers: { fileId: string; path: string; size: number; mimeType: string }[] = [];
      const dossiers: string[] = [];
      let total = 0;
      let tronque = false;
      const LIMITE = 5_000;

      const parcourir = (dossier: NonNullable<typeof racine>, prefixe: string) => {
        const enfants = [...(dossier.children ?? [])].sort((a, b) =>
          (a.name ?? '').localeCompare(b.name ?? '', 'fr'),
        );
        for (const enfant of enfants) {
          if (fichiers.length >= LIMITE) {
            tronque = true;
            return;
          }
          const nom = enfant.name || 'Sans nom';
          const chemin = prefixe ? `${prefixe}/${nom}` : nom;
          if (enfant.directory) {
            dossiers.push(chemin);
            parcourir(enfant, chemin);
          } else {
            const taille = Math.max(0, Number(enfant.size) || 0);
            total += taille;
            fichiers.push({
              fileId: enfant.nodeId ?? enfant.downloadId ?? nom,
              path: chemin,
              size: taille,
              mimeType: mimeFromName(nom),
            });
          }
        }
      };
      parcourir(racine, '');

      return {
        files: fichiers,
        folders: dossiers,
        // MEGA n'a pas de documents natifs : rien n'est écarté.
        skipped: [],
        truncated: tronque,
        totalBytes: total,
      };
    } finally {
      this.session.relacher(accountId);
    }
  }

  /** Espace utilisé et total du compte. */
  async usage(accountId: string): Promise<{ usedBytes: number; quotaBytes: number }> {
    return this.session.mesurer(accountId);
  }

  /* ------------------------------------------------------------------------
   * Téléchargement
   * ---------------------------------------------------------------------- */

  async start(request: MegaDownloadRequest): Promise<void> {
    const existant = this.jobs.get(request.id);
    if (existant && (existant.status === 'paused' || existant.status === 'error')) {
      log(`MEGA ${request.id} : reprise demandée (${existant.status})`);
      await this.resume(request.id);
      return;
    }
    if (existant && existant.status === 'running') return;

    this.jobs.set(request.id, {
      request,
      status: 'running',
      received: 0,
      size: request.size,
      paused: false,
    });
    await this.run(this.jobs.get(request.id)!);
  }

  async pause(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return;
    job.paused = true;
    job.stopper?.();
    job.status = 'paused';
    this.emitDownload({ id, status: 'paused', received: job.received, size: job.size, speed: 0 });
  }

  async resume(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'paused' && job.status !== 'error')) return false;
    job.paused = false;
    job.status = 'running';
    this.emitDownload({
      id,
      status: 'running',
      received: job.received,
      size: job.size,
      speed: 0,
    });
    await this.run(job);
    return true;
  }

  async cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.stopper?.();
    this.jobs.delete(id);
    if (job.partPath) await rm(job.partPath, { force: true }).catch(() => undefined);
    this.emitDownload({ id, status: 'error', received: job.received, size: job.size, speed: 0, message: 'annulé' });
  }

  private async run(job: Job): Promise<void> {
    const { request } = job;
    // La session de ce compte ne doit pas être libérée pour faire de la place
    // pendant que son fichier descend.
    this.session.retenir(request.accountId);
    try {
      if (!job.partPath || !job.finalPath) {
        const dossier = relativeDir(request.dir || (await this.fallbackDir()), request.subPath);
        await mkdir(dossier, { recursive: true });
        const finalPath = await uniquePath(dossier, request.name);
        job.finalPath = finalPath;
        job.partPath = `${finalPath}.part`;
      }
      const partPath = job.partPath;
      const finalPath = job.finalPath;

      const storage = await this.session.storage(request.accountId);
      const nœud = storage.files[request.fileId];
      if (!nœud || nœud.directory) throw new Error('fichier MEGA introuvable');
      if (!job.size) job.size = Number(nœud.size) || 0;

      // La taille réelle du partiel fait foi : une fermeture brutale laisse un
      // fichier plus court que ce que l'interface croyait avoir reçu.
      const deja = await stat(partPath).then((info) => info.size).catch(() => 0);
      if (deja > 0) log(`MEGA ${request.id} : reprise à ${deja} o`);

      const flux = nœud.download({ start: deja });
      let dernier = 0;
      let dernierEmission = 0;
      let minuteur: NodeJS.Timeout | null = null;
      const relancerVeilleur = () => {
        if (minuteur) clearTimeout(minuteur);
        minuteur = setTimeout(() => {
          job.stopper?.();
        }, SILENCE_MAX_MS);
      };
      job.stopper = () => {
        if (minuteur) clearTimeout(minuteur);
        minuteur = null;
        flux.destroy();
      };
      relancerVeilleur();

      const compteur = new Transform({
        transform: (morceau: Buffer, _encodage, suite) => {
          relancerVeilleur();
          job.received += morceau.length;
          const maintenant = Date.now();
          if (maintenant - dernierEmission >= 250) {
            const secondes = Math.max((maintenant - dernier) / 1000, 0.001);
            dernier = maintenant;
            dernierEmission = maintenant;
            this.emitDownload({
              id: request.id,
              status: 'running',
              received: job.received,
              size: job.size,
              speed: 0,
            });
            void secondes;
          }
          suite(null, morceau);
        },
      });

      await new Promise<void>((resolve, rejeter) => {
        pipeline(flux, compteur, createWriteStream(partPath, { flags: deja > 0 ? 'a' : 'w' }), (erreur) =>
          erreur ? rejeter(erreur) : resolve(),
        );
      });
      if (minuteur) clearTimeout(minuteur);
      job.stopper = undefined;

      await rename(partPath, finalPath);
      job.partPath = undefined;
      job.status = 'done';
      job.received = job.size || job.received;
      log(`MEGA ${request.id} : terminé (${job.size} o) → ${finalPath}`);
      this.emitDownload({
        id: request.id,
        name: request.name,
        status: 'done',
        received: job.received,
        size: job.size,
        speed: 0,
      });
    } catch (cause) {
      job.stopper = undefined;
      if (job.paused) return; // la pause a déjà émis son état
      if (sessionExpiree(cause)) await this.session.storage(request.accountId).catch(() => undefined);
      const message = messageErreurMega(cause);
      job.status = 'error';
      log(`MEGA ${request.id} : échec — ${message}`);
      // Le partiel reste : la reprise s'appuie dessus.
      this.emitDownload({
        id: request.id,
        name: request.name,
        status: 'error',
        received: job.received,
        size: job.size,
        speed: 0,
        message,
      });
    } finally {
      this.session.relacher(request.accountId);
    }
  }

  /* ------------------------------------------------------------------------
   * Téléversement
   * ---------------------------------------------------------------------- */

  /**
   * Envoie un fichier local dans un dossier du compte.
   *
   * Un seul transfert à la fois côté MEGA : le service limite la charge, et
   * empiler les envois sur un compte gratuit ne ferait qu'ajouter des échecs.
   */
  async upload(accountId: string, folderId: string, chemin: string): Promise<void> {
    this.compteur += 1;
    const id = `mega-upload-${this.compteur}`;
    const nom = safeFileName(basename(chemin));
    const taille = await stat(chemin).then((info) => info.size).catch(() => 0);
    this.emitUpload({ id, accountId, name: nom, status: 'running', received: 0, size: taille });

    this.session.retenir(accountId);
    try {
      const storage = await this.session.storage(accountId);
      const dossier = folderId ? storage.files[folderId] : storage.root;
      if (!dossier) throw new Error('dossier MEGA introuvable');

      // `megajs` accepte un flux en entrée, mais ses types ne déclarent qu'un
      // tampon : la conversion est explicite plutôt que silencieuse.
      const envoi = dossier.upload(
        { name: nom, size: taille },
        createReadStream(chemin) as unknown as string,
      );
      let dernier = 0;
      let dernierEmission = 0;
      envoi.on('progress', (progression: { bytesLoaded?: number }) => {
        const charges = Math.max(0, Number(progression.bytesLoaded) || 0);
        const maintenant = Date.now();
        if (maintenant - dernierEmission < 250) return;
        dernier = maintenant;
        dernierEmission = maintenant;
        this.emitUpload({
          id,
          accountId,
          name: nom,
          status: 'running',
          received: charges,
          size: taille,
        });
        void dernier;
      });

      await envoi.complete;
      log(`MEGA : « ${nom} » téléversé (${taille} o)`);
      this.emitUpload({ id, accountId, name: nom, status: 'done', received: taille, size: taille });
      // L'espace utilisé vient de changer : on le remesure tout de suite.
      void this.session.mesurer(accountId).catch(() => undefined);
    } catch (cause) {
      const message = messageErreurMega(cause);
      log(`MEGA : téléversement de « ${nom} » impossible — ${message}`);
      this.emitUpload({
        id,
        accountId,
        name: nom,
        status: 'error',
        received: 0,
        size: taille,
        message,
      });
    } finally {
      this.session.relacher(accountId);
    }
  }
}
