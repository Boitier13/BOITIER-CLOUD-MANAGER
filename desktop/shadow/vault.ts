/** Coffre séparé : seul le jeton WebDAV dédié est conservé, chiffré par Windows. */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Protect, Unprotect } from '../google/vault.ts';

export interface ShadowStoredAccount {
  id: string;
  name: string;
  username: string;
  url: string;
  token: string;
  usedBytes: number;
  quotaBytes: number;
}

export class ShadowVault {
  private readonly path: string;
  private readonly protect: Protect;
  private readonly unprotect: Unprotect;
  private data: ShadowStoredAccount[] | null = null;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(dir: string, protect: Protect, unprotect: Unprotect) {
    this.path = join(dir, 'shadow-accounts.enc');
    this.protect = protect;
    this.unprotect = unprotect;
  }
  private async load(): Promise<void> {
    if (this.data) return;
    if (this.failed) throw new Error('Coffre Shadow Drive illisible : aucune modification possible.');
    let cipher: Buffer;
    try { cipher = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.data = []; return; }
      this.failed = true; throw new Error('Coffre Shadow Drive inaccessible.');
    }
    try {
      const plain = this.unprotect(cipher);
      if (!plain) throw new Error();
      const value: unknown = JSON.parse(plain);
      if (!Array.isArray(value) || !value.every((v) => v && typeof v.id === 'string' && typeof v.username === 'string' && typeof v.token === 'string' && typeof v.url === 'string')) throw new Error();
      this.data = value as ShadowStoredAccount[];
    } catch { this.failed = true; throw new Error('Coffre Shadow Drive illisible : aucune modification possible.'); }
  }
  async accounts(): Promise<ShadowStoredAccount[]> {
    await this.queue; await this.load();
    return this.data!.map((account) => ({ ...account }));
  }
  async change(fn: (accounts: ShadowStoredAccount[]) => ShadowStoredAccount[]): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.load();
      const next = fn(this.data!.map((account) => ({ ...account })));
      const cipher = this.protect(JSON.stringify(next));
      if (!cipher) throw new Error('Le chiffrement Windows est indisponible : compte non enregistré.');
      await mkdir(join(this.path, '..'), { recursive: true });
      await writeFile(`${this.path}.tmp`, cipher, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
      this.data = next;
      await copyFile(this.path, `${this.path}.bak`).catch(() => undefined);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
}
