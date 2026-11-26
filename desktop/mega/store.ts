/**
 * Sessions MEGA conservées chiffrées sur le disque.
 *
 * MEGA n'a pas d'OAuth : la seule façon de ne pas redemander le mot de passe à
 * chaque lancement serait de le stocker. On stocke donc **la session**, jamais
 * le mot de passe — `megajs` sérialise la clé maître et l'identifiant de
 * session (`sid`), largement suffisants pour rouvrir le compte. Le fichier est
 * chiffré par le système (DPAPI via `safeStorage`), comme les jetons Google.
 *
 * Si MEGA invalide la session (mot de passe changé, session fermée ailleurs),
 * la lecture échoue proprement et l'application redemande le mot de passe.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Protect, Unprotect } from '../google/vault.ts';

/** Session sérialisée par `megajs` — sans les identifiants de connexion. */
export interface MegaSessionJson {
  /** Clé maître du compte, encodée. */
  key: string;
  /** Identifiant de session MEGA. */
  sid: string;
  name: string;
  user: string;
}

export interface MegaStoredAccount {
  /** Identifiant MEGA du compte (handle utilisateur), stable. */
  id: string;
  email: string;
  name: string;
  session: MegaSessionJson;
  addedAt: string;
  /** Dernier espace mesuré — MEGA n'est pas interrogé à chaque lancement. */
  usedBytes?: number;
  quotaBytes?: number;
}

interface MegaVaultData {
  version: 1;
  accounts: MegaStoredAccount[];
}

const EMPTY: MegaVaultData = { version: 1, accounts: [] };

function sanitize(value: unknown): MegaVaultData {
  if (!value || typeof value !== 'object') return { ...EMPTY };
  const raw = value as Partial<MegaVaultData>;
  const accounts = Array.isArray(raw.accounts)
    ? raw.accounts.filter((account): account is MegaStoredAccount => {
        if (!account || typeof account !== 'object') return false;
        const session = account.session as Partial<MegaSessionJson> | undefined;
        return (
          typeof account.id === 'string' &&
          typeof account.email === 'string' &&
          !!session &&
          typeof session.key === 'string' &&
          typeof session.sid === 'string'
        );
      })
    : [];
  return { version: 1, accounts };
}

export class MegaVault {
  private readonly dir: string;
  private readonly protect: Protect;
  private readonly unprotect: Unprotect;
  private writing: Promise<void> = Promise.resolve();

  constructor(dir: string, protect: Protect, unprotect: Unprotect) {
    this.dir = dir;
    this.protect = protect;
    this.unprotect = unprotect;
  }

  private get file(): string {
    return join(this.dir, 'mega-sessions.enc');
  }

  async read(): Promise<MegaStoredAccount[]> {
    try {
      const chiffre = await readFile(this.file);
      const clair = this.unprotect(chiffre);
      if (!clair) return [];
      return sanitize(JSON.parse(clair)).accounts;
    } catch {
      // Fichier absent ou illisible : aucun compte MEGA, jamais une erreur
      // bloquante au démarrage.
      return [];
    }
  }

  async write(accounts: MegaStoredAccount[]): Promise<void> {
    const contenu = JSON.stringify({ version: 1, accounts } satisfies MegaVaultData);
    const chiffre = this.protect(contenu);
    if (!chiffre) throw new Error('le chiffrement du système est indisponible');
    this.writing = this.writing.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const temporaire = `${this.file}.tmp`;
      await writeFile(temporaire, chiffre, { mode: 0o600 });
      await rename(temporaire, this.file);
    });
    await this.writing;
  }
}
