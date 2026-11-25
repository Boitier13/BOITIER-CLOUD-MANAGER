/**
 * Configuration du client OAuth Google.
 *
 * Source unique de vérité, dans cet ordre :
 *   1. variables d'environnement (pratique en développement) ;
 *   2. identifiants saisis dans l'application, stockés chiffrés par DPAPI.
 *
 * Aucune valeur n'est jamais écrite dans le dépôt : le fichier `.env.local`
 * sert uniquement à alimenter les variables d'environnement en local.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Charge `.env.local` à la racine du projet en développement.
 * Le fichier n'est jamais versionné : il ne contient que le client OAuth local.
 */
export function loadEnvFile(root = process.cwd()): void {
  for (const name of ['.env.local', '.env']) {
    try {
      const raw = readFileSync(join(root, name), 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!match) continue;
        const [, key, value] = match;
        if (process.env[key]) continue;
        process.env[key] = value.replace(/^["']|["']$/g, '').trim();
      }
      return;
    } catch {
      /* fichier absent : configuration saisie dans l'application */
    }
  }
}

export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
}

export function readGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig {
  const clientId = env.BOITIER_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.BOITIER_GOOGLE_CLIENT_SECRET?.trim();
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}
