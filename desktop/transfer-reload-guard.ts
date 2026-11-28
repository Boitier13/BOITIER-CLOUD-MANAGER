/** Arrête les transferts réels lorsque leur interface est rechargée. */
import type { DownloadEvent } from './google/downloads.ts';

type Entry = { started: boolean; stopping: boolean; pauseSent: boolean; pause: () => Promise<void> | void };
export class TransferReloadGuard {
  private readonly entries = new Map<string, Entry>();
  private generation = 0;
  private ready = false;
  private waiters = new Set<() => void>();
  private readonly timeoutMs: number;
  constructor(timeoutMs = 30_000) { this.timeoutMs = timeoutMs; }

  rendererReady(): void { this.ready = true; }
  interrupt(): void {
    this.ready = false;
    this.generation += 1;
    for (const entry of this.entries.values()) entry.stopping = true;
    for (const entry of this.entries.values()) this.pauseIfStarted(entry);
    this.releaseIfStopped();
  }
  private pauseIfStarted(entry: Entry): void {
    if (!entry.stopping || !entry.started || entry.pauseSent) return;
    entry.pauseSent = true;
    // Si la pause échoue, on ne libère pas la barrière : un flux peut rester actif.
    try { void Promise.resolve(entry.pause()).catch(() => undefined); } catch { /* barrière conservée */ }
  }
  private releaseIfStopped(): void {
    if ([...this.entries.values()].some((entry) => entry.stopping)) return;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  private async waitForStop(): Promise<void> {
    if (![...this.entries.values()].some((entry) => entry.stopping)) return;
    await new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(() => { this.waiters.delete(done); reject(new Error('Les transferts précédents ne sont pas encore arrêtés. Réessayez.')); }, this.timeoutMs);
      this.waiters.add(done);
    });
  }
  async start<T>(id: string, launch: () => Promise<T>, pause: () => Promise<void> | void): Promise<T> {
    const generation = this.generation;
    if (!this.ready) throw new Error('Interface en cours de rechargement : réessayez.');
    await this.waitForStop();
    if (!this.ready || generation !== this.generation) throw new Error('Interface rechargée : relancez ce transfert.');
    if (this.entries.has(id)) throw new Error('Ce transfert est déjà en cours.');
    const entry: Entry = { started: false, stopping: false, pauseSent: false, pause };
    this.entries.set(id, entry);
    try {
      const result = await launch();
      if (result === false && this.entries.get(id) === entry) {
        this.entries.delete(id); this.releaseIfStopped();
      } else if (this.entries.get(id) === entry) {
        entry.started = true; this.pauseIfStarted(entry);
      }
      return result;
    } catch (error) {
      if (this.entries.get(id) === entry) { this.entries.delete(id); this.releaseIfStopped(); }
      throw error;
    }
  }
  observe(event: DownloadEvent): void {
    const entry = this.entries.get(event.id);
    if (!entry) return;
    if (event.status === 'running') { entry.started = true; this.pauseIfStarted(entry); return; }
    if (event.status === 'paused' || event.status === 'done' || event.status === 'error') {
      this.entries.delete(event.id); this.releaseIfStopped();
    }
  }
}
