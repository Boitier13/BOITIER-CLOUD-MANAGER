/**
 * Assemblage du service Google : configuration du client OAuth, connexion d'un
 * compte, sessions, exploration et téléchargements.
 *
 * Aucune fonction de ce fichier n'écrit de jeton en clair : le chiffrement est
 * délégué au coffre (`vault.ts`) qui reçoit `protect`/`unprotect` du processus
 * principal (DPAPI sous Windows).
 */

import { createHash } from 'node:crypto';
import { GoogleSession } from './tokens.ts';
import { DownloadManager } from './downloads.ts';
import {
  exchangeCode,
  OAuthError,
  revokeToken,
  runLoopbackFlow,
  type OAuthConfig,
  type OAuthTokens,
} from './oauth.ts';
import { endpointsFromEnv, type Endpoints } from './endpoints.ts';
import { planFolder, type FolderPlan } from './tree.ts';
import { canonicalGmail } from '../../src/lib/accounts.ts';
import { readStorageUsage, type StorageUsage } from './storage.ts';
import {
  listChildren,
  listRecent,
  listShared,
  readItem,
  readQuota,
  searchFiles,
  type DriveItem,
  type DriveQuota,
} from './drive.ts';
import type { StoredAccount, StoredClient, Vault, VaultReport } from './vault.ts';

export type AccountView = {
  accountId: string;
  name: string;
  email: string;
  picture?: string;
  usedBytes: number;
  quotaBytes: number;
  status: 'connected' | 'expired';
  /** Date du dernier consentement Google (voir `StoredAccount`). */
  authorizedAt?: string;
  /** Vrai si ce compte était déjà connecté : la connexion l'a mis à jour. */
  alreadyConnected?: boolean;
};

export type ClientStatus = {
  configured: boolean;
  source: 'env' | 'store' | 'none';
  /** Identifiant client connu (public, jamais le secret). */
  clientId?: string;
};

export interface GoogleServiceOptions {
  vault: Vault;
  /** Dossier de travail de l'application (coffre chiffré). */
  userDataDir: string;
  /** Ouvrir une URL dans le navigateur système. */
  openExternal: (url: string) => void;
  /** Dossier de téléchargement par défaut (système). */
  downloadsDir: () => Promise<string>;
  /** Diffusion des événements de transfert vers l'interface. */
  emitDownload: (event: import('./downloads.ts').DownloadEvent) => void;
  endpoints?: Endpoints;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Identifiant local stable, dérivé du compte Google (jamais du jeton).
 *
 * On hache la forme **canonique** de l'adresse : `firstboitier1+2@gmail.com` et
 * `first.boitier1@gmail.com` désignent la même boîte et reçoivent donc le même
 * identifiant. Sans cela, une deuxième connexion créerait un second compte
 * fantôme pointant vers le même Drive — ou, selon l'ordre, écraserait le
 * premier en silence.
 */
const accountIdFrom = (email: string) => {
  const key = canonicalGmail(email) ?? email.trim().toLowerCase();
  return `gdrive-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
};

export class GoogleService {
  private readonly options: GoogleServiceOptions;
  private readonly endpoints: Endpoints;
  private readonly session: GoogleSession;
  private readonly downloads: DownloadManager;

  constructor(options: GoogleServiceOptions) {
    this.options = options;
    this.endpoints = options.endpoints ?? endpointsFromEnv();
    this.session = new GoogleSession(options.vault, this.endpoints);
    this.downloads = new DownloadManager(
      this.endpoints,
      options.emitDownload,
      options.downloadsDir,
    );
  }

  async clientStatus(): Promise<ClientStatus> {
    const { config, source } = await this.session.resolveClient({
      ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
      ...(this.options.clientSecret ? { clientSecret: this.options.clientSecret } : {}),
    });
    return {
      configured: Boolean(config),
      source,
      ...(config?.clientId ? { clientId: config.clientId } : {}),
    };
  }

  async setClient(client: StoredClient): Promise<ClientStatus> {
    await this.session.saveClient(client);
    // La configuration saisie prend le pas sur un éventuel fichier d'environnement.
    this.options.clientId = undefined;
    this.options.clientSecret = undefined;
    return this.clientStatus();
  }

  private async config(): Promise<OAuthConfig> {
    const { config } = await this.session.resolveClient({
      ...(this.options.clientId ? { clientId: this.options.clientId } : {}),
      ...(this.options.clientSecret ? { clientSecret: this.options.clientSecret } : {}),
    });
    if (!config) {
      throw new Error(
        'Aucun client OAuth Google configuré. Renseignez l’identifiant client (et le secret du client « Desktop app ») dans l’application.',
      );
    }
    return config;
  }

  async accounts(): Promise<AccountView[]> {
    return (await this.session.accounts()).map(toView);
  }

  /** État du coffre pour le diagnostic (aucun jeton, aucune donnée secrète). */
  async report(): Promise<VaultReport> {
    return this.options.vault.describe();
  }

  /**
   * Connexion complète : consentement, échange de code, quota initial.
   *
   * Le compte est **mis à jour** si son identifiant canonique est déjà présent.
   * C'est volontaire : Google renvoie toujours l'adresse principale, donc
   * autoriser `firstboitier1+2@gmail.com` quand `firstboitier1@gmail.com` est
   * déjà connecté ne doit pas créer une seconde entrée pointant vers le même
   * Drive. La vue porte `alreadyConnected` pour que l'interface puisse le dire.
   */
  async connect(): Promise<AccountView> {
    const config = await this.config();
    const callback = await runLoopbackFlow(config, this.options.openExternal);
    const tokens: OAuthTokens = await exchangeCode(
      config,
      callback.code,
      callback.redirectUri,
      callback.verifier,
    );

    let quota: DriveQuota;
    try {
      quota = await readQuota(this.endpoints, tokens.accessToken);
    } catch (cause) {
      await revokeToken(tokens.refreshToken ?? tokens.accessToken);
      throw cause;
    }
    if (!quota.email) throw new Error('Google n’a pas renvoyé d’adresse pour ce compte.');

    const id = accountIdFrom(quota.email);
    const existing = await this.session.account(id);
    const now = new Date().toISOString();
    const account: StoredAccount = {
      id,
      name: quota.name,
      email: quota.email,
      ...(quota.picture ? { picture: quota.picture } : {}),
      usedBytes: quota.usedBytes,
      quotaBytes: quota.quotaBytes,
      status: 'connected',
      // La date de première connexion est conservée : elle sert à ordonner les
      // comptes dans l'interface.
      createdAt: existing?.createdAt ?? now,
      // À chaque consentement, la date est réécrite : c'est elle qui dit si le
      // jeton est récent.
      authorizedAt: now,
      tokens: {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      },
    };
    await this.session.saveAccount(account);
    return { ...toView(account), ...(existing ? { alreadyConnected: true } : {}) };
  }

  async disconnect(accountId: string): Promise<void> {
    const config = await this.config().catch(() => null);
    await this.session.removeAccount(accountId, config);
  }

  /** Jeton valide, avec marquage « session expirée » en cas de révocation. */
  private async token(accountId: string): Promise<string> {
    const config = await this.config();
    try {
      return await this.session.accessToken(accountId, config);
    } catch (cause) {
      if (cause instanceof OAuthError && cause.code === 'invalid_grant') {
        await this.session.markExpired(accountId);
      }
      throw cause;
    }
  }

  async list(accountId: string, folderId: string): Promise<DriveItem[]> {
    return listChildren(this.endpoints, await this.token(accountId), folderId || 'root');
  }

  /** Fichiers partagés avec ce compte (hors dossiers de l'utilisateur). */
  async shared(accountId: string): Promise<DriveItem[]> {
    return listShared(this.endpoints, await this.token(accountId));
  }

  /**
   * Derniers fichiers modifiés du compte, tous dossiers confondus.
   *
   * La fenêtre (en jours) et le plafond sont des paramètres : l'interface peut
   * demander « 7 jours » ou « 30 jours » sans nouvelle méthode.
   */
  async recent(
    accountId: string,
    options: { days?: number; limit?: number } = {},
  ): Promise<DriveItem[]> {
    return listRecent(this.endpoints, await this.token(accountId), {
      ...(options.days ? { days: Number(options.days) } : {}),
      ...(options.limit ? { limit: Number(options.limit) } : {}),
    });
  }

  /**
   * Répartition du stockage du compte.
   *
   * Le quota vient de Google et est exact ; la répartition par catégorie est
   * mesurée par des requêtes bornées. Les deux sont renvoyés ensemble pour que
   * l'écran puisse dire honnêtement ce qui est complet et ce qui ne l'est pas.
   */
  async storage(accountId: string): Promise<StorageUsage> {
    const token = await this.token(accountId);
    const quota = await readQuota(this.endpoints, token);
    return readStorageUsage(this.endpoints, token, quota);
  }

  async search(accountId: string, term: string): Promise<DriveItem[]> {
    const query = term.trim();
    if (query.length < 2) return [];
    return searchFiles(this.endpoints, await this.token(accountId), query);
  }

  /**
   * Chemin d'un élément, de la racine du compte jusqu'à son dossier parent.
   *
   * Sert à ouvrir l'explorateur **là où se trouve** un fichier trouvé par la
   * recherche multi-comptes : sans cela, un résultat ne mènerait nulle part.
   * Une requête par niveau (un fichier est rarement profond), la racine du
   * compte étant exclue du chemin — elle n'est pas un dossier de l'utilisateur.
   */
  async locate(accountId: string, fileId: string): Promise<{ id: string; name: string }[]> {
    const token = await this.token(accountId);
    const root = await readItem(this.endpoints, token, 'root');
    const trail: { id: string; name: string }[] = [];
    const seen = new Set<string>([fileId, root.id]);
    let parentId = (await readItem(this.endpoints, token, fileId)).parentId;
    // 20 niveaux : bien au-delà d'une arborescence réelle, et un garde-fou
    // contre une boucle de parents (racine partagée mal formée).
    for (let depth = 0; parentId && depth < 20; depth += 1) {
      if (seen.has(parentId)) break;
      seen.add(parentId);
      const folder = await readItem(this.endpoints, token, parentId);
      trail.unshift({ id: folder.id, name: folder.name });
      parentId = folder.parentId;
    }
    return trail;
  }

  async download(request: {
    id: string;
    accountId: string;
    fileId: string;
    name: string;
    size: number;
    dir?: string;
    subPath?: string;
  }): Promise<void> {
    const token = await this.token(request.accountId);
    await this.downloads.start(
      {
        id: request.id,
        fileId: request.fileId,
        name: request.name,
        size: request.size,
        dir: request.dir ?? '',
        ...(request.subPath ? { subPath: request.subPath } : {}),
      },
      token,
    );
  }

  /**
   * Contenu d'un dossier, sans rien télécharger.
   *
   * Sert à préparer un téléchargement de dossier entier : l'interface reçoit un
   * plan (chemins relatifs, tailles), pas l'arborescence brute. Un dossier de
   * plusieurs milliers de fichiers ne bloque donc pas la fenêtre.
   */
  async plan(accountId: string, folderId: string): Promise<FolderPlan> {
    return planFolder(this.endpoints, await this.token(accountId), folderId || 'root');
  }

  pause(id: string): void {
    this.downloads.pause(id);
  }

  async resume(id: string, accountId: string): Promise<boolean> {
    const token = await this.token(accountId);
    return this.downloads.resume(id, token);
  }

  cancel(id: string): void {
    this.downloads.cancel(id);
  }

  async downloadsFolder(): Promise<string> {
    return this.options.downloadsDir();
  }

  /** Rafraîchit le quota affiché (bouton « resynchroniser »). */
  async refresh(accountId: string): Promise<AccountView | null> {
    const config = await this.config();
    await this.session.refreshQuota(accountId, config);
    const account = await this.session.account(accountId);
    return account ? toView(account) : null;
  }
}

function toView(account: StoredAccount): AccountView {
  return {
    accountId: account.id,
    name: account.name,
    email: account.email,
    ...(account.picture ? { picture: account.picture } : {}),
    usedBytes: account.usedBytes,
    quotaBytes: account.quotaBytes,
    status: account.status,
    ...(account.authorizedAt ? { authorizedAt: account.authorizedAt } : {}),
  };
}

