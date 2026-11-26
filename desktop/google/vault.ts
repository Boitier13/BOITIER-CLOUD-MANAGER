/**
 * Chiffrement des autorisations Google avec DPAPI (Windows).
 *
 * `protect`/`unprotect` sont fournis par le processus principal d'Electron via
 * `safeStorage` : la clé maître reste gérée par le système d'exploitation et
 * n'est jamais écrite sur le disque. Ce fichier ne fait que l'entrée/sortie.
 */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { log } from '../log.ts';

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
  /**
   * Date du dernier consentement Google (celle du jeton de rafraîchissement).
   *
   * `createdAt` ne bouge plus après le premier ajout : il ne dit donc pas si
   * l'autorisation est récente. Or c'est cette date-là qui décide de la durée
   * de vie du jeton. Absente, elle signifie « autorisation antérieure à cette
   * version » — donc à renouveler une fois.
   */
  authorizedAt?: string;
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
  /**
   * Le fichier existe mais n'a pas pu être relu.
   *
   * Dans ce cas, **aucune écriture n'est permise** : persister un coffre vide
   * effacerait définitivement des comptes que le disque contient encore. C'est
   * la seule façon de garantir qu'un incident de déchiffrement (profil Windows
   * différent, antivirus, fichier verrouillé) ne se transforme pas en perte de
   * comptes.
   */
  private illisible = false;
  /** Écritures sérialisées : deux enregistrements simultanés ne se perdent plus. */
  private ecriture: Promise<void> = Promise.resolve();
  private derniereTaille = 0;

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

  /** Chemin de la sauvegarde de secours (une version précédente du coffre). */
  private get sauvegarde(): string {
    return `${this.file}.bak`;
  }

  /** Déchiffre et valide un contenu ; `null` s'il n'est pas exploitable. */
  private decoder(chiffre: Buffer): VaultData | null {
    try {
      const clair = this.unprotect(chiffre);
      if (!clair) return null;
      return sanitize(JSON.parse(clair));
    } catch {
      return null;
    }
  }

  private async load(): Promise<void> {
    let existe = false;
    try {
      await stat(this.file);
      existe = true;
    } catch {
      existe = false;
    }

    if (!existe) {
      // Premier lancement : coffre vide assumé, les écritures sont permises.
      this.data = { ...EMPTY };
      return;
    }

    try {
      const chiffre = await readFile(this.file);
      const data = this.decoder(chiffre);
      if (data) {
        this.data = data;
        this.derniereTaille = data.accounts.length;
        log(`coffre : ${data.accounts.length} compte(s) Google relu(s)`);
        return;
      }
      throw new Error('déchiffrement impossible');
    } catch (cause) {
      // Le fichier existe mais ne se lit pas. On tente la sauvegarde avant de
      // conclure — puis on interdit toute écriture.
      log(`coffre : fichier illisible (${(cause as Error).message}) — tentative de sauvegarde`);
      const restaure = await readFile(this.sauvegarde).catch(() => null);
      if (restaure) {
        const data = this.decoder(restaure);
        if (data) {
          this.data = data;
          this.derniereTaille = data.accounts.length;
          log(`coffre : sauvegarde restaurée — ${data.accounts.length} compte(s)`);
          return;
        }
      }
      this.illisible = true;
      log('coffre : illisible et sans sauvegarde — écritures bloquées pour ne rien effacer');
    }
  }

  private async persist(): Promise<void> {
    if (this.illisible) {
      throw new Error(
        'Coffre Google illisible : écritures bloquées pour ne pas effacer les comptes.',
      );
    }
    await mkdir(dirname(this.file), { recursive: true });
    const cipher = this.protect(JSON.stringify(this.data));
    if (!cipher) throw new Error('Chiffrement indisponible sur ce poste.');
    // Écriture atomique : jamais de fichier de jetons tronqué.
    const temp = `${this.file}.tmp`;
    await writeFile(temp, cipher, { mode: 0o600 });
    await rename(temp, this.file);
    // Copie de secours, tenue à jour après chaque écriture réussie : si le
    // fichier principal devient illisible (profil Windows, antivirus, disque),
    // la version précédente reste disponible et sera restaurée au lancement.
    await copyFile(this.file, this.sauvegarde).catch(() => undefined);
    const nombre = this.data.accounts.length;
    // Une écriture qui ferait baisser le nombre de comptes est signalée : c'est
    // exactement la trace qui manquait pour comprendre une disparition.
    if (nombre < this.derniereTaille) {
      log(`coffre : ${nombre} compte(s) écrit(s), contre ${this.derniereTaille} avant`);
    }
    this.derniereTaille = nombre;
  }

  async read(): Promise<VaultData> {
    await this.ready;
    return this.data;
  }

  async update(mutate: (draft: VaultData) => void): Promise<VaultData> {
    await this.ready;
    if (this.illisible) {
      throw new Error(
        'Coffre Google illisible : écritures bloquées pour ne pas effacer les comptes.',
      );
    }
    // Les mutations sont appliquées puis écrites l'une après l'autre : deux
    // ajouts simultanés ne peuvent plus se recouvrir (le second écrasait le
    // premier).
    const suite = this.ecriture.then(async () => {
      const draft: VaultData = JSON.parse(JSON.stringify(this.data)) as VaultData;
      mutate(draft);
      this.data = draft;
      await this.persist();
    });
    this.ecriture = suite.catch(() => undefined);
    await suite;
    return this.data;
  }
}
