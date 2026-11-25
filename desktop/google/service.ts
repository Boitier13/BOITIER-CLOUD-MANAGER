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
import {
  listChildren,
  listShared,
  readQuota,
  searchFiles,
  type DriveItem,
  type DriveQuota,
} from './drive.ts';
import type { StoredAccount, StoredClient, Vault } from './vault.ts';

export type AccountView = {
  accountId: string;
  name: string;
  email: string;
  picture?: string;
  usedBytes: number;
  quotaBytes: number;
  status: 'connected' | 'expired';
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

/** Identifiant local stable, dérivé du compte Google (jamais du jeton). */
const accountIdFrom = (email: string) =>
  `gdrive-${createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12)}`;

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

  /** Connexion complète : consentement, échange de code, quota initial. */
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

    const now = new Date().toISOString();
    const account: StoredAccount = {
      id: accountIdFrom(quota.email),
      name: quota.name,
      email: quota.email,
      ...(quota.picture ? { picture: quota.picture } : {}),
      usedBytes: quota.usedBytes,
      quotaBytes: quota.quotaBytes,
      status: 'connected',
      createdAt: now,
      tokens: {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      },
    };
    await this.session.saveAccount(account);
    return toView(account);
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

  async search(accountId: string, term: string): Promise<DriveItem[]> {
    const query = term.trim();
    if (query.length < 2) return [];
    return searchFiles(this.endpoints, await this.token(accountId), query);
  }

  async download(request: {
    id: string;
    accountId: string;
    fileId: string;
    name: string;
    size: number;
    dir?: string;
  }): Promise<void> {
    const token = await this.token(request.accountId);
    await this.downloads.start(
      {
        id: request.id,
        fileId: request.fileId,
        name: request.name,
        size: request.size,
        dir: request.dir ?? '',
      },
      token,
    );
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
  };
}

