/** Coffre de sessions TeraBox distinct des autres fournisseurs. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Protect, Unprotect } from '../google/vault.ts';

export interface TeraBoxStoredAccount {
  id: string;
  name: string;
  session: string;
  usedBytes: number;
  quotaBytes: number;
}
function validAccount(v: unknown): v is TeraBoxStoredAccount {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return typeof a.id === 'string' && /^terabox-[0-9]+$/.test(a.id)
    && typeof a.name === 'string' && a.name.length > 0 && a.name.length <= 100
    && typeof a.session === 'string' && /^[A-Za-z0-9._~-]{8,4096}$/.test(a.session)
    && Number.isSafeInteger(a.usedBytes) && Number(a.usedBytes) >= 0
    && Number.isSafeInteger(a.quotaBytes) && Number(a.quotaBytes) >= 0;
}
export class TeraBoxVault {
  private readonly path: string;
  private readonly protect: Protect;
  private readonly unprotect: Unprotect;
  private data: TeraBoxStoredAccount[] | null = null;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(dir: string, protect: Protect, unprotect: Unprotect) {
    this.path = join(dir, 'terabox-accounts.enc'); this.protect = protect; this.unprotect = unprotect;
  }
  private async load(): Promise<void> {
    if (this.data) return;
    if (this.failed) throw new Error('Coffre TeraBox illisible : aucune modification possible.');
    let cipher: Buffer;
    try { cipher = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.data = []; return; }
      this.failed = true; throw new Error('Coffre TeraBox inaccessible.');
    }
    try {
      const plain = this.unprotect(cipher);
      if (!plain) throw new Error();
      const value: unknown = JSON.parse(plain);
      if (!Array.isArray(value) || !value.every(validAccount) || new Set(value.map((v) => v.id)).size !== value.length) throw new Error();
      this.data = value;
    } catch { this.failed = true; throw new Error('Coffre TeraBox illisible : aucune modification possible.'); }
  }
  async accounts(): Promise<TeraBoxStoredAccount[]> {
    await this.queue; await this.load();
    return this.data!.map((a) => ({ ...a }));
  }
  async change(fn: (accounts: TeraBoxStoredAccount[]) => TeraBoxStoredAccount[]): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.load();
      const next = fn(this.data!.map((a) => ({ ...a })));
      if (!next.every(validAccount) || new Set(next.map((a) => a.id)).size !== next.length) throw new Error('Données TeraBox invalides.');
      const cipher = this.protect(JSON.stringify(next));
      if (!cipher) throw new Error('Le chiffrement Windows est indisponible : compte non enregistré.');
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, cipher, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
