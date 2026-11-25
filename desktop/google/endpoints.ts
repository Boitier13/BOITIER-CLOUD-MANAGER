/**
 * En-têtes et petits utilitaires HTTP du pont desktop.
 * Permet de tester la logique Drive contre un faux serveur local.
 */

export interface Endpoints {
  token: string;
  revoke: string;
  auth: string;
  userinfo: string;
  drive: string;
}

export function endpointsFromEnv(): Endpoints {
  return {
    auth: process.env.BOITIER_GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    token: process.env.BOITIER_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    revoke: process.env.BOITIER_GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
    userinfo: process.env.BOITIER_GOOGLE_USERINFO_URL ?? 'https://www.googleapis.com/oauth2/v3/userinfo',
    drive: process.env.BOITIER_GOOGLE_DRIVE_URL ?? 'https://www.googleapis.com/drive/v3',
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
