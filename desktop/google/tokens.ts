/**
 * Session Google : rafraîchissement silencieux des jetons, lecture du quota.
 *
 * Les jetons ne quittent jamais ce module : seules des métadonnées
 * (nom, adresse, quota, statut) remontent vers l'interface.
 */

import { refreshAccessToken, revokeToken, type OAuthConfig } from './oauth.ts';
import { readQuota, type DriveQuota } from './drive.ts';
import type { Vault, StoredAccount, StoredClient } from './vault.ts';
import type { Endpoints } from './endpoints.ts';

/** Marge avant expiration : on rafraîchit 2 minutes avant l'échéance. */
const EXPIRY_MARGIN = 120_000;

export class GoogleSession {
  private readonly vault: Vault;
  private readonly endpoints: Endpoints;
  /** Jeton d'accès actif en mémoire uniquement, le temps de la session. */
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<StoredAccount>>();

  constructor(vault: Vault, endpoints: Endpoints) {
    this.vault = vault;
    this.endpoints = endpoints;
  }

  /** Configuration OAuth effective : `.env.local` prioritaire, puis le coffre. */
  async resolveClient(env: { clientId?: string; clientSecret?: string }): Promise<{
    config: OAuthConfig | null;
    source: 'env' | 'store' | 'none';
  }> {
    if (env.clientId) {
      return {
        config: { clientId: env.clientId, ...(env.clientSecret ? { clientSecret: env.clientSecret } : {}) },
        source: 'env',
      };
    }
    const vault = await this.vault.read();
    if (vault.client?.clientId) {
      return {
        config: {
          clientId: vault.client.clientId,
          ...(vault.client.clientSecret ? { clientSecret: vault.client.clientSecret } : {}),
        },
        source: 'store',
      };
    }
    return { config: null, source: 'none' };
  }

  /** Enregistre le client OAuth saisi dans l'application (chiffré). */
  async saveClient(client: StoredClient): Promise<void> {
    await this.vault.update((draft) => {
      draft.client = client;
    });
  }

  async accounts(): Promise<StoredAccount[]> {
    const vault = await this.vault.read();
    return vault.accounts;
  }

  async account(id: string): Promise<StoredAccount | undefined> {
    const vault = await this.vault.read();
    return vault.accounts.find((item) => item.id === id);
  }

  async saveAccount(account: StoredAccount): Promise<void> {
    await this.vault.update((draft) => {
      const index = draft.accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) draft.accounts[index] = account;
      else draft.accounts.push(account);
    });
    this.cache.clear();
  }

  async markExpired(id: string): Promise<void> {
    await this.vault.update((draft) => {
      const target = draft.accounts.find((item) => item.id === id);
      if (target) target.status = 'expired';
    });
    this.cache.delete(id);
  }

  async removeAccount(id: string, config: OAuthConfig | null): Promise<void> {
    const current = await this.account(id);
    if (current && config) {
      await revokeToken(current.tokens.refreshToken ?? current.tokens.accessToken);
    }
    await this.vault.update((draft) => {
      draft.accounts = draft.accounts.filter((item) => item.id !== id);
    });
    this.cache.clear();
  }

  /**
   * Jeton d'accès valide pour ce compte, rafraîchi si nécessaire.
   * Lève une erreur `invalid_grant` quand l'autorisation a été révoquée.
   */
  async accessToken(id: string, config: OAuthConfig): Promise<string> {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt - EXPIRY_MARGIN > Date.now()) return cached.token;

    const pending = this.inflight.get(id);
    if (pending) return (await pending).tokens.accessToken;

    const task = this.refresh(id, config);
    this.inflight.set(id, task);
    try {
      return (await task).tokens.accessToken;
    } finally {
      this.inflight.delete(id);
    }
  }

  private async refresh(id: string, config: OAuthConfig): Promise<StoredAccount> {
    const current = await this.account(id);
    if (!current) throw new Error('Compte Google inconnu.');
    if (!current.tokens.refreshToken) {
      await this.markExpired(id);
      const error = new Error('Aucun jeton de rafraîchissement : reconnexion requise.') as Error & {
        code?: string;
      };
      error.code = 'invalid_grant';
      throw error;
    }

    try {
      const tokens = await refreshAccessToken(config, current.tokens.refreshToken);
      const updated: StoredAccount = {
        ...current,
        status: 'connected',
        tokens: {
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          refreshToken: tokens.refreshToken ?? current.tokens.refreshToken,
        },
      };
      await this.vault.update((draft) => {
        const index = draft.accounts.findIndex((item) => item.id === id);
        if (index >= 0) draft.accounts[index] = updated;
      });
      this.cache.set(id, { token: updated.tokens.accessToken, expiresAt: updated.tokens.expiresAt });
      return updated;
    } catch (cause) {
      const code = (cause as Error & { code?: string }).code;
      if (code === 'invalid_grant') {
        await this.markExpired(id);
        this.cache.delete(id);
      }
      throw cause;
    }
  }

  /** Rafraîchit le quota stocké après un changement notable (upload externe). */
  async refreshQuota(id: string, config: OAuthConfig): Promise<DriveQuota | null> {
    try {
      const token = await this.accessToken(id, config);
      const quota = await readQuota(this.endpoints, token);
      await this.vault.update((draft) => {
        const target = draft.accounts.find((item) => item.id === id);
        if (!target) return;
        target.usedBytes = quota.usedBytes;
        target.quotaBytes = quota.quotaBytes;
        if (quota.picture) target.picture = quota.picture;
      });
      return quota;
    } catch {
      return null;
    }
  }
}
