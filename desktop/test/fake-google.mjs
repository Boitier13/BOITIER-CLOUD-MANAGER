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
    // Racine du compte : Drive la désigne par l'alias `root` et ne la liste
    // jamais comme un dossier ordinaire. Sa date est volontairement ancienne
    // pour ne pas fausser le flux « récents ».
    id: 'root',
    name: 'Mon Drive',
    mimeType: 'application/vnd.google-apps.folder',
    modifiedTime: '2020-01-01T00:00:00.000Z',
    parents: [],
  },
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
    id: 'file-partage',
    name: 'Planning équipe.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: '15360',
    modifiedTime: '2026-11-24T18:00:00.000Z',
    parents: ['shared-root'],
    shared: true,
    ownedByMe: false,
  },
  {
    // Archive appartenant à quelqu'un d'autre : elle n'occupe pas le quota de
    // l'utilisateur et ne doit donc pas entrer dans la mesure du stockage.
    // C'est exactement le cas qui affichait 13 Go d'archives sur un compte
    // à quelques mégaoctets.
    id: 'file-archive-etrangere',
    name: 'Sauvegarde partagée.zip',
    mimeType: 'application/zip',
    size: '13958643712',
    modifiedTime: '2026-11-19T07:00:00.000Z',
    parents: ['shared-root'],
    shared: false,
    ownedByMe: false,
  },
  {
    // Fichier en corbeille : `trashed = false` doit l'écarter de la mesure.
    id: 'file-video-corbeille',
    name: 'Ancienne capture.mp4',
    mimeType: 'video/mp4',
    size: '5368709120',
    modifiedTime: '2026-11-18T07:00:00.000Z',
    parents: ['shared-root'],
    trashed: true,
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
      // `usage` > `usageInDrive` : Google distingue Drive de Gmail/Photos, ce
      // que l'écran Stockage doit savoir afficher sans le deviner.
      storageQuota: { limit: '16106127360', usage: '3221225472', usageInDrive: '2684354560' },
    });
  }

  if (url.pathname === '/drive/v3/files') {
    const q = url.searchParams.get('q') ?? '';
    let result = FILES;
    const parentMatch = /'([^']+)' in parents/.exec(q);
    const searchMatch = /name contains '([^']+)'/.exec(q);
    // like `sharedWithMe = true` : fichiers partagés par d'autres personnes.
    const sharedOnly = /sharedWithMe\s*=\s*true/.test(q);
    // Flux « récents » : `modifiedTime > '...'`.
    const recentMatch = /modifiedTime > '([^']+)'/.exec(q);
    if (recentMatch) {
      const since = new Date(recentMatch[1]).getTime();
      result = result.filter((file) => new Date(file.modifiedTime).getTime() >= since);
    }
    // Mesure du stockage : `mimeType contains 'video/'` & co.
    const mimeMatch = /mimeType contains '([^']+)'/.exec(q);
    if (mimeMatch) result = result.filter((file) => file.mimeType.includes(mimeMatch[1]));
    // `'me' in owners` et `trashed = false` : sans ces deux filtres, le faux
    // Drive serait plus complaisant que le vrai et les tests de stockage ne
    // prouveraient rien.
    if (/'me' in owners/.test(q)) {
      result = result.filter((file) => file.ownedByMe !== false);
    }
    if (/trashed = false/.test(q)) {
      result = result.filter((file) => file.trashed !== true);
    }
    if (sharedOnly) result = result.filter((file) => file.shared === true);
    if (parentMatch) result = result.filter((file) => file.parents?.includes(parentMatch[1]));
    if (searchMatch) {
      const term = searchMatch[1].toLowerCase();
      result = result.filter((file) => file.name.toLowerCase().includes(term));
    }
    // Tri : le vrai Drive applique `orderBy`; le faux doit faire pareil, sinon
    // le test du flux « récents » ne prouverait rien.
    const orderBy = url.searchParams.get('orderBy') ?? '';
    if (orderBy === 'modifiedTime desc') {
      result = [...result].sort(
        (a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime(),
      );
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
