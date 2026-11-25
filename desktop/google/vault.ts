/**
 * Chiffrement des autorisations Google avec DPAPI (Windows).
 *
 * `protect`/`unprotect` sont fournis par le processus principal d'Electron via
 * `safeStorage` : la clé maître reste gérée par le système d'exploitation et
 * n'est jamais écrite sur le disque. Ce fichier ne fait que l'entrée/sortie.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Protect = (plain: string) => Buffer | null;
export type Unprotect = (cipher: Buffer) => string | null;

interface TokenPair {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

/** Compte tel que stocké (jamais exposé tel quel au renderer). */
export interface StoredAccount {
  id: string;
  name: string;
  email: string;
  picture?: string;
  usedBytes: number;
  quotaBytes: number;
  status: 'connected' | 'expired';
  createdAt: string;
  tokens: TokenPair;
}

export interface StoredClient {
  clientId: string;
  clientSecret?: string;
}

export interface VaultData {
  version: 1;
  client?: StoredClient;
  accounts: StoredAccount[];
}

const EMPTY: VaultData = { version: 1, accounts: [] };

function sanitize(value: unknown): VaultData {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  const raw = value as Partial<VaultData>;
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts.filter(
        (account): account is StoredAccount =>
          !!account &&
          typeof account.id === 'string' &&
          typeof account.email === 'string' &&
          !!account.tokens &&
          typeof account.tokens.accessToken === 'string',
      )
    : [];
  const client =
    raw.client && typeof raw.client.clientId === 'string' && raw.client.clientId
      ? {
          clientId: raw.client.clientId,
          ...(typeof raw.client.clientSecret === 'string'
            ? { clientSecret: raw.client.clientSecret }
            : {}),
        }
      : undefined;
  return { version: 1, ...(client ? { client } : {}), accounts };
}

export class Vault {
  private readonly file: string;
  private readonly protect: Protect;
  private readonly unprotect: Unprotect;
  private data: VaultData = { ...EMPTY };
  private ready: Promise<void>;

  constructor(
    userDataDir: string,
    protect: Protect,
    unprotect: Unprotect,
    fileName = 'google-accounts.enc',
  ) {
    this.file = join(userDataDir, fileName);
    this.protect = protect;
    this.unprotect = unprotect;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const cipher = await readFile(this.file);
      const plain = this.unprotect(cipher);
      if (!plain) return;
      this.data = sanitize(JSON.parse(plain));
    } catch {
      // Fichier absent ou illisible : on repart d'un coffre vide.
      this.data = { ...EMPTY };
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const cipher = this.protect(JSON.stringify(this.data));
    if (!cipher) throw new Error('Chiffrement indisponible sur ce poste.');
    // Écriture atomique : jamais de fichier de jetons tronqué.
    const temp = `${this.file}.tmp`;
    await writeFile(temp, cipher, { mode: 0o600 });
    await rename(temp, this.file);
  }

  async read(): Promise<VaultData> {
    await this.ready;
    return this.data;
  }

  async update(mutate: (draft: VaultData) => void): Promise<VaultData> {
    await this.ready;
    const draft: VaultData = JSON.parse(JSON.stringify(this.data)) as VaultData;
    mutate(draft);
    this.data = draft;
    await this.persist();
    return this.data;
  }
}
