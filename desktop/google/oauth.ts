/**
 * Flux OAuth 2.0 « application installée » de Google.
 *
 * - Redirection par boucle locale sur 127.0.0.1 (port éphémère choisi par l'OS).
 * - PKCE S256 obligatoire, `state` aléatoire contre le CSRF.
 * - Aucun mot de passe n'est jamais demandé : la saisie a lieu chez Google,
 *   dans le navigateur du système.
 *
 * Ce module est volontairement pur (aucun import d'Electron) pour rester
 * exécutable et testable sous Node.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OAuthConfig {
  clientId: string;
  /** Fourni par Google pour un client « Desktop app » ; non confidentiel. */
  clientSecret?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
}

/** Périmètre minimal : lecture seule, plus l'identité du compte. */
export const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'openid',
  'email',
  'profile',
];

const authEndpoint = () =>
  process.env.BOITIER_GOOGLE_AUTH_URL ??
  'https://accounts.google.com/o/oauth2/v2/auth';

const tokenEndpoint = () =>
  process.env.BOITIER_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';

export class OAuthError extends Error {
  readonly code: string;

  constructor(message: string, code = 'oauth') {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomUrlSafe(bytes: number): string {
  return base64url(randomBytes(bytes));
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomUrlSafe(48);
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

interface CallbackResult {
  code: string;
  redirectUri: string;
  verifier: string;
}

const SUCCESS_PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>BOITIER CLOUD MANAGER</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e8e4dc;font:14px/1.6 'Segoe UI',system-ui,sans-serif">
<div style="text-align:center;max-width:420px;padding:32px">
<div style="width:38px;height:38px;border-radius:10px;background:#d2b283;color:#101114;display:grid;place-items:center;margin:0 auto 18px;font-weight:600">B</div>
<h1 style="font-size:17px;font-weight:600;margin:0 0 8px">Connexion réussie</h1>
<p style="margin:0;color:#9a968d">Vous pouvez fermer cet onglet et revenir à l’application.</p>
</div></body></html>`;

const ERROR_PAGE = (message: string) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>BOITIER CLOUD MANAGER</title></head>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b0d10;color:#e8e4dc;font:14px/1.6 'Segoe UI',system-ui,sans-serif">
<div style="text-align:center;max-width:420px;padding:32px">
<h1 style="font-size:17px;font-weight:600;margin:0 0 8px">Connexion interrompue</h1>
<p style="margin:0;color:#9a968d">${message}</p>
</div></body></html>`;

/**
 * Ouvre le consentement Google dans le navigateur système et attend le retour
 * sur la boucle locale.
 *
 * @param openUrl reçoit l'URL de consentement ; l'appelant l'ouvre dans le
 *   navigateur par défaut.
 */
export function runLoopbackFlow(
  config: OAuthConfig,
  openUrl: (url: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<CallbackResult> {
  const pkce = createPkcePair();
  const state = randomUrlSafe(24);

  return new Promise<CallbackResult>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        response
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(ERROR_PAGE('Le consentement Google a été refusé ou annulé.'));
        finish(new OAuthError('Consentement Google refusé.', 'denied'));
        return;
      }

      if (url.searchParams.get('state') !== state) {
        response
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(ERROR_PAGE('La réponse ne correspond pas à la demande initiale.'));
        finish(new OAuthError('Réponse OAuth invalide (state).', 'state'));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        response
          .writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          .end(ERROR_PAGE('Le code d’autorisation est absent.'));
        finish(new OAuthError('Code d’autorisation absent.', 'code'));
        return;
      }

      response
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(SUCCESS_PAGE);
      finish(null, {
        code,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        verifier: pkce.verifier,
      });
    });

    let port = 0;
    let settled = false;

    const close = () => {
      try {
        server.close();
      } catch {
        /* déjà fermé */
      }
    };

    const finish = (error: OAuthError | null, result?: CallbackResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Laisse la réponse HTTP partir avant de fermer la socket.
      setTimeout(close, 120);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new OAuthError('Délai dépassé : aucune réponse de Google.', 'timeout'));
    }, timeoutMs);
    timer.unref?.();

    server.on('error', (cause) => {
      finish(new OAuthError(`Impossible d’ouvrir la boucle locale : ${cause.message}`, 'socket'));
    });

    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const authorizeUrl = new URL(authEndpoint());
      authorizeUrl.searchParams.set('client_id', config.clientId);
      authorizeUrl.searchParams.set('redirect_uri', redirectUri);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('scope', SCOPES.join(' '));
      authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('access_type', 'offline');
      authorizeUrl.searchParams.set('prompt', 'consent');
      authorizeUrl.searchParams.set('include_granted_scopes', 'true');
      openUrl(authorizeUrl.toString());
    });
  });
}

async function tokenRequest(
  config: OAuthConfig,
  body: Record<string, string>,
): Promise<OAuthTokens> {
  const payload = new URLSearchParams({
    client_id: config.clientId,
    ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    ...body,
  });

  let response: Response;
  try {
    response = await fetch(tokenEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: payload.toString(),
    });
  } catch (cause) {
    throw new OAuthError(
      `Google est injoignable (${(cause as Error).message}).`,
      'network',
    );
  }

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* réponse non JSON */
  }

  if (!response.ok) {
    const detail = typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
    const description =
      typeof parsed.error_description === 'string' ? parsed.error_description : '';
    throw new OAuthError(
      description || `Échange de jeton refusé (${detail}).`,
      detail === 'invalid_grant' ? 'invalid_grant' : 'token',
    );
  }

  const accessToken = typeof parsed.access_token === 'string' ? parsed.access_token : '';
  if (!accessToken) throw new OAuthError('Réponse de jeton incomplète.', 'token');

  const expiresIn = Number(parsed.expires_in ?? 3600);
  return {
    accessToken,
    refreshToken:
      typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
  };
}

export function exchangeCode(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<OAuthTokens> {
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

export function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<OAuthTokens> {
  return tokenRequest(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

/** Révoque l'accès côté Google (le jeton local doit ensuite être effacé). */
export async function revokeToken(token: string): Promise<void> {
  const endpoint =
    process.env.BOITIER_GOOGLE_REVOKE_URL ??
    'https://oauth2.googleapis.com/revoke';
  try {
    await fetch(`${endpoint}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    /* révocation hors ligne : le jeton local est supprimé de toute façon */
  }
}
