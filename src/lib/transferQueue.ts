import type { GoogleDownloadEvent, GoogleDownloadRequest } from './bridge';
import type { ProviderId } from '../data/catalog';

type Request = GoogleDownloadRequest & { provider?: ProviderId };
type Event = Omit<GoogleDownloadEvent, 'status'> & { status: GoogleDownloadEvent['status'] | 'queued' };
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : 'Téléchargement impossible.';
}
type Phase = 'queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'cancelling';
type Job = { request: Request; phase: Phase; started: boolean; action?: 'pause' | 'cancel'; resumeAfterPause?: boolean; received: number; size: number };
export interface QueueTransport {
  start(request: Request): Promise<void>;
  pause(provider: ProviderId, id: string): Promise<void>;
  resume(provider: ProviderId, id: string, account?: string): Promise<boolean | void>;
  cancel(provider: ProviderId, id: string): Promise<void>;
}

/** File globale : les places restent occupées jusqu'à l'arrêt effectif du flux. */
export class TransferQueue {
  private readonly jobs = new Map<string, Job>();
  private limit = 3;
  private listener: (event: Event) => void = () => undefined;
  private readonly transport: QueueTransport;
  constructor(transport: QueueTransport) { this.transport = transport; }
  subscribe(listener: (event: Event) => void) { this.listener = listener; return () => { if (this.listener === listener) this.listener = () => undefined; }; }
  setLimit(value: number) { this.limit = Number.isFinite(value) ? Math.max(1, Math.min(6, Math.floor(value))) : 3; this.drain(); }
  private event(job: Job, status: Event['status'], message?: string) {
    const event = { id: job.request.id, status, received: job.received, size: job.size, speed: 0, ...(message ? { message } : {}) };
    queueMicrotask(() => this.listener(event));
  }
  add(request: Request) {
    if (this.jobs.has(request.id)) throw new Error('Ce téléchargement est déjà dans la file.');
    const job: Job = { request, phase: 'queued', started: false, received: 0, size: request.size };
    this.jobs.set(request.id, job); this.event(job, 'queued'); this.drain();
  }
  private active() { return [...this.jobs.values()].filter((j) => j.phase === 'starting' || j.phase === 'running' || j.phase === 'pausing' || j.phase === 'cancelling').length; }
  private drain() {
    while (this.active() < this.limit) {
      const job = [...this.jobs.values()].find((j) => j.phase === 'queued');
      if (!job) break;
      const restart = job.started;
      job.phase = 'starting'; job.started = true; this.event(job, 'running');
      const provider = job.request.provider ?? 'gdrive';
      const task = restart ? this.transport.resume(provider, job.request.id, job.request.accountId).then((ok) => {
        if (ok === false) throw new Error('Impossible de reprendre ce téléchargement.');
      }) : this.transport.start(job.request);
      void task.then(() => {
        if (this.jobs.get(job.request.id) !== job) return;
        if (job.phase === 'starting') { job.phase = 'running'; if (job.action) this.performAction(job); }
      }).catch((error: unknown) => {
        if (this.jobs.get(job.request.id) !== job) return;
        this.jobs.delete(job.request.id);
        this.event(job, 'error', errorMessage(error));
        this.drain();
      });
    }
  }
  observe(event: GoogleDownloadEvent) {
    const job = this.jobs.get(event.id);
    if (!job) return;
    job.received = event.received; job.size = event.size;
    if (event.status === 'running') {
      if (job.phase === 'starting') { job.phase = 'running'; if (job.action) { this.performAction(job); return; } }
      if (job.phase === 'running') queueMicrotask(() => this.listener(event));
      return;
    }
    if (event.status === 'paused') {
      if (job.phase === 'cancelling') return;
      job.phase = 'paused'; job.action = undefined; queueMicrotask(() => this.listener(event));
      if (job.resumeAfterPause) { job.resumeAfterPause = false; job.phase = 'queued'; this.jobs.delete(event.id); this.jobs.set(event.id, job); this.event(job, 'queued'); }
      this.drain(); return;
    }
    this.jobs.delete(event.id);
    if (job.phase !== 'cancelling') queueMicrotask(() => this.listener(event));
    this.drain();
  }
  pause(id: string) {
    const job = this.jobs.get(id); if (!job) return;
    if (job.phase === 'queued') { job.phase = 'paused'; this.event(job, 'paused'); return; }
    if (job.phase === 'starting') { job.action = 'pause'; return; }
    if (job.phase === 'running') { job.action = 'pause'; this.performAction(job); }
  }
  resume(id: string): boolean {
    const job = this.jobs.get(id); if (!job) return false;
    if (job.phase === 'pausing' || (job.phase === 'starting' && job.action === 'pause')) { job.resumeAfterPause = true; return true; }
    if (job.phase === 'paused') { job.phase = 'queued'; this.jobs.delete(id); this.jobs.set(id, job); this.event(job, 'queued'); this.drain(); }
    return true;
  }
  cancel(id: string) {
    const job = this.jobs.get(id); if (!job) return;
    if (job.phase === 'starting') { job.action = 'cancel'; return; }
    if (job.phase === 'running' || job.phase === 'pausing') { job.action = 'cancel'; this.performAction(job); return; }
    this.jobs.delete(id);
    if (job.started) void this.transport.cancel(job.request.provider ?? 'gdrive', id).catch(() => undefined);
    this.drain();
  }
  private performAction(job: Job) {
    const action = job.action; job.action = undefined; if (!action) return;
    job.phase = action === 'pause' ? 'pausing' : 'cancelling';
    const provider = job.request.provider ?? 'gdrive';
    const task = action === 'pause' ? this.transport.pause(provider, job.request.id) : this.transport.cancel(provider, job.request.id);
    void task.catch((error: unknown) => {
      if (this.jobs.get(job.request.id) !== job) return;
      this.jobs.delete(job.request.id);
      this.event(job, 'error', errorMessage(error));
      this.drain();
    });
  }
}
