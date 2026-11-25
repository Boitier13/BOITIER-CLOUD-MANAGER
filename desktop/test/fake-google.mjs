/**
 * Faux serveur Google pour les tests locaux.
 *
 * Implémente le strict nécessaire : consentement (redirection immédiate),
 * échange de jeton, rafraîchissement, révocation, `about`, `files.list`,
 * `files.get` (métadonnées) et `files.get?alt=media`.
 *
 * Aucune requête ne sort de la machine : les URL Google sont remplacées par
 * les variables d'environnement BOITIER_GOOGLE_*.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_GOOGLE_PORT ?? 4319);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCESS = 'fake-access-token';
const REFRESH = 'fake-refresh-token';
const CODE = 'fake-auth-code';

const CONTENT = Buffer.from('BOITIER CLOUD MANAGER — test de téléchargement Google Drive.\n');

const FILES = [
  {
    id: 'folder-projets',
    name: 'Projets',
    mimeType: 'application/vnd.google-apps.folder',
    modifiedTime: '2026-11-20T10:00:00.000Z',
    parents: ['root'],
  },
  {
    id: 'folder-2026',
    name: '2026',
    mimeType: 'application/vnd.google-apps.folder',
    modifiedTime: '2026-11-21T09:00:00.000Z',
    parents: ['folder-projets'],
  },
  {
    id: 'file-notes',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: String(CONTENT.length),
    modifiedTime: '2026-11-22T08:30:00.000Z',
    parents: ['root'],
  },
  {
    id: 'file-devis',
    name: 'Devis 2026.pdf',
    mimeType: 'application/pdf',
    size: '48211',
    modifiedTime: '2026-11-23T16:10:00.000Z',
    parents: ['folder-projets'],
  },
  {
    id: 'file-doc',
    name: 'Compte rendu',
    mimeType: 'application/vnd.google-apps.document',
    modifiedTime: '2026-11-24T11:45:00.000Z',
    parents: ['folder-2026'],
  },
];

/** Jetons révoqués, consultables via GET /state pour les tests. */
const REVOKED = [];

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);

  // Consentement : renvoie immédiatement le code vers la boucle locale.
  if (url.pathname === '/o/oauth2/v2/auth') {
    const redirect = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? '';
    res.writeHead(302, { location: `${redirect}?code=${CODE}&state=${state}` });
    res.end();
    return;
  }

  if (url.pathname === '/token') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (params.get('grant_type') === 'authorization_code') {
      if (params.get('code') !== CODE) return json(res, 400, { error: 'invalid_grant' });
      return json(res, 200, {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
      });
    }
    if (params.get('grant_type') === 'refresh_token') {
      if (params.get('refresh_token') !== REFRESH) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      return json(res, 200, { access_token: ACCESS, expires_in: 3600 });
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  if (url.pathname === '/revoke') {
    // Trace la révocation : permet de vérifier qu'elle est bien demandée.
    REVOKED.push(url.searchParams.get('token') ?? '');
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }

  if (url.pathname === '/state') {
    return json(res, 200, { revoked: REVOKED });
  }

  if (url.pathname === '/userinfo') {
    return json(res, 200, {
      email: 'boitier.test@gmail.com',
      name: 'Boitier Test',
      picture: '',
    });
  }

  const authorized = req.headers.authorization === `Bearer ${ACCESS}`;
  if (url.pathname.startsWith('/drive/v3') && !authorized) {
    return json(res, 401, { error: { message: 'Unauthorized' } });
  }

  if (url.pathname === '/drive/v3/about') {
    return json(res, 200, {
      user: { displayName: 'Boitier Test', emailAddress: 'boitier.test@gmail.com' },
      storageQuota: { limit: '16106127360', usage: '2684354560', usageInDrive: '2684354560' },
    });
  }

  if (url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q') ?? '';
    let result = FILES;
    const parentMatch = /'([^']+)' in parents/.exec(q);
    const searchMatch = /name contains '([^']+)'/.exec(q);
    if (parentMatch) result = result.filter((file) => file.parents?.includes(parentMatch[1]));
    if (searchMatch) {
      const term = searchMatch[1].toLowerCase();
      result = result.filter((file) => file.name.toLowerCase().includes(term));
    }
    return json(res, 200, { files: result });
  }

  const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
  if (fileMatch) {
    const file = FILES.find((item) => item.id === decodeURIComponent(fileMatch[1]));
    if (!file) return json(res, 404, { error: { message: 'File not found' } });
    if (url.searchParams.get('alt') === 'media') {
      if (file.mimeType.startsWith('application/vnd.google-apps.')) {
        return json(res, 403, {
          error: { message: 'Only files with binary content can be downloaded.' },
        });
      }
      const body = file.id === 'file-notes' ? CONTENT : Buffer.alloc(Number(file.size ?? 0), 0x42);
      res.writeHead(200, {
        'content-type': file.mimeType,
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
    return json(res, 200, file);
  }

  json(res, 404, { error: { message: 'Unknown endpoint' } });
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, base: BASE, port: PORT, content: CONTENT.toString().trim() }));
});
