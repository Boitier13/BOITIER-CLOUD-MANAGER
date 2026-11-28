/**
 * Adaptateur expérimental pour l'interface Web non officielle de TeraBox.
 *
 * Délibérément isolé : aucune dépendance du reste de l'application, aucune
 * écriture distante, aucun contournement de CAPTCHA ni des restrictions d'offre.
 * La session ne doit jamais transiter par le renderer, les logs ou une URL.
 */
import type { TeraBoxEntry, TeraBoxReader } from './provider.ts';

const DEFAULT_ORIGIN = 'https://www.terabox.com';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

type Fetch = typeof fetch;
export type WebEntry = TeraBoxEntry;
export interface WebAccount { id: string; usedBytes: number; quotaBytes: number }

function remotePath(path: string): string {
  if (typeof path !== 'string' || path.length > 4096 || !path.startsWith('/') || path.includes('\0') || path.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('Chemin TeraBox invalide.');
  }
  return path;
}
function numberValue(value: unknown, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Réponse TeraBox invalide : ${label}.`);
  return n;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Réponse TeraBox invalide.');
  return value as Record<string, unknown>;
}
function apiError(value: Record<string, unknown>): void {
  if (value.errno === 0) return;
  if ([2, -6, 31023].includes(Number(value.errno))) throw new Error('Session TeraBox expirée ou accès refusé : reconnectez le compte.');
  throw new Error('TeraBox a refusé la demande ou exige une vérification sur son site.');
}
function entry(raw: unknown): WebEntry {
  const r = record(raw);
  const path = remotePath(String(r.path ?? ''));
  const name = String(r.server_filename ?? '');
  if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name) || path.split('/').pop() !== name) throw new Error('Nom de fichier TeraBox invalide.');
  const directory = Number(r.isdir) === 1;
  if (!directory && Number(r.isdir) !== 0) throw new Error('Type de fichier TeraBox invalide.');
  const size = directory ? 0 : numberValue(r.size, 'taille');
  const seconds = numberValue(r.server_mtime, 'date');
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) throw new Error('Date TeraBox invalide.');
  return { path, name, directory, size, modified: date.toISOString() };
}
async function jsonBounded(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Réponse TeraBox vide.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new Error('Réponse TeraBox trop volumineuse.'); }
    chunks.push(part.value);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new Error('Réponse TeraBox illisible : une vérification sur le site peut être nécessaire.'); }
}

export class TeraBoxWebClient implements TeraBoxReader {
  private origin = DEFAULT_ORIGIN;
  private readonly session: string;
  private readonly send: Fetch;
  /** Test injection replaces transport only, never the allowed host. */
  constructor(ndus: string, send: Fetch = fetch) {
    if (typeof ndus !== 'string' || !/^[A-Za-z0-9._~-]{8,4096}$/.test(ndus)) throw new Error('Session TeraBox invalide.');
    this.session = ndus;
    this.send = send;
  }
  private async request(path: string, method: 'GET' | 'POST', data?: URLSearchParams): Promise<{ value: Record<string, unknown>; region: string | null }> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith('/api/')) throw new Error('Adresse TeraBox interdite.');
    const options: RequestInit = {
      method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': USER_AGENT, cookie: `lang=en; ndus=${this.session}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    };
    if (method === 'GET' && data) url.search = data.toString();
    if (method === 'POST' && data) options.body = data.toString();
    let response: Response;
    try { response = await this.send(url, options); }
    catch { throw new Error('Connexion TeraBox impossible ou redirection refusée.'); }
    if (response.status === 401 || response.status === 403) throw new Error('Session TeraBox expirée ou accès refusé : reconnectez le compte.');
    if (response.status === 429) throw new Error('TeraBox demande de patienter avant de réessayer.');
    if (!response.ok) throw new Error(`TeraBox a refusé la demande (${response.status}).`);
    const region = response.headers.get('region-domain-prefix');
    if (region) { await response.body?.cancel(); return { value: {}, region }; }
    return { value: await jsonBounded(response), region: null };
  }
  /** Vérifie l'identité, puis adopte au plus une région TeraBox validée. */
  async identity(): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { value, region } = await this.request('/api/check/login', 'GET');
      if (region) {
        if (attempt || !/^[a-z0-9-]{1,63}$/i.test(region)) throw new Error('Région TeraBox non reconnue.');
        this.origin = `https://${region.toLowerCase()}.terabox.com`;
        continue;
      }
      apiError(value);
      const id = String(value.uk ?? '');
      if (!/^[0-9]{1,15}$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error('Identité TeraBox non disponible.');
      return id;
    }
    throw new Error('Région TeraBox non reconnue.');
  }
  async quota(): Promise<{ usedBytes: number; quotaBytes: number }> {
    const { value, region } = await this.request('/api/quota', 'GET', new URLSearchParams({ checkexpire: '1', checkfree: '1' }));
    if (region) throw new Error('Session TeraBox à reconnecter.');
    apiError(value);
    return { usedBytes: numberValue(value.used, 'espace utilisé'), quotaBytes: numberValue(value.total, 'quota') };
  }
  /** Charge toutes les pages ou annonce explicitement la limite. */
  async list(path = '/'): Promise<WebEntry[]> {
    remotePath(path);
    const items: WebEntry[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const data = new URLSearchParams({ order: 'name', desc: '0', dir: path, num: String(PAGE_SIZE), page: String(page), showempty: '0' });
      const { value, region } = await this.request('/api/list', 'POST', data);
      if (region) throw new Error('Session TeraBox à reconnecter.');
      apiError(value);
      if (!Array.isArray(value.list)) throw new Error('Liste TeraBox invalide.');
      const entries = value.list.map(entry);
      const prefix = path === '/' ? '/' : `${path.replace(/\/$/, '')}/`;
      if (entries.some((f) => !f.path.startsWith(prefix) || f.path.slice(prefix.length).includes('/'))) throw new Error('Liste TeraBox hors du dossier demandé.');
      items.push(...entries);
      if (entries.length < PAGE_SIZE) return items;
    }
    throw new Error('Dossier TeraBox trop volumineux : la liste n’est pas complète.');
  }
  /** Recherche bornée à une page, à annoncer comme telle par l'interface. */
  async search(query: string): Promise<WebEntry[]> {
    if (query.trim().length < 2) return [];
    const params = new URLSearchParams({ order: 'name', desc: '0', num: String(PAGE_SIZE), page: '1', recursion: '1', key: query.trim() });
    const { value, region } = await this.request('/api/search', 'GET', params);
    if (region) throw new Error('Session TeraBox à reconnecter.');
    apiError(value);
    if (!Array.isArray(value.list)) throw new Error('Recherche TeraBox invalide.');
    if (value.list.length >= PAGE_SIZE || Number(value.has_more) > 0) throw new Error('Trop de résultats TeraBox : affinez la recherche.');
    return value.list.map(entry);
  }
  /** Flux sans cookie, URL signée jamais affichée ou enregistrée. */
  async openContent(url: string, size: number, fileName: string, signal: AbortSignal, resume?: { from: number; etag: string }): Promise<Response> {
    const strongEtag = (value: string | null): value is string => Boolean(value && /^"[\x21\x23-\x7e]{1,256}"$/.test(value));
    if (resume && (!Number.isSafeInteger(resume.from) || resume.from <= 0 || resume.from >= size || !strongEtag(resume.etag))) {
      throw new Error('Reprise TeraBox invalide.');
    }
    let target: URL;
    try { target = new URL(url); } catch { throw new Error('Lien de téléchargement TeraBox invalide.'); }
    for (let hops = 0; hops <= 3; hops += 1) {
      const host = target.hostname.toLowerCase();
      const allowed = ['terabox.com'].some((domain) => host === domain || host.endsWith(`.${domain}`));
      if (target.protocol !== 'https:' || !allowed || target.username || target.password || target.port) throw new Error('Hôte de téléchargement TeraBox non autorisé.');
      let response: Response;
      try {
        response = await this.send(target, { method: 'GET', redirect: 'manual', signal, headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...(resume ? { range: `bytes=${resume.from}-`, 'if-range': resume.etag } : {}) } });
      } catch (cause) {
        if (signal.aborted) throw cause;
        throw new Error('Téléchargement TeraBox injoignable.');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hops === 3) throw new Error('Redirection de téléchargement TeraBox invalide.');
        try { target = new URL(location, target); } catch { throw new Error('Redirection de téléchargement TeraBox invalide.'); }
        continue;
      }
      if (!response.body) throw new Error('TeraBox refuse le téléchargement ou le lien a expiré.');
      const refuse = async (message: string): Promise<never> => { await response.body!.cancel().catch(() => undefined); throw new Error(message); };
      if (response.status !== 200 && response.status !== 206) return refuse('TeraBox refuse le téléchargement ou le lien a expiré.');
      const etag = response.headers.get('etag');
      if (response.status === 206) {
        const range = response.headers.get('content-range');
        if (!resume || etag !== resume.etag || range !== `bytes ${resume.from}-${size - 1}/${size}`) {
          return refuse('Reprise TeraBox invalide : version ou plage du fichier incohérente.');
        }
      }
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') return refuse('Encodage TeraBox incompatible avec la vérification du fichier.');
      const expectedLength = response.status === 206 && resume ? size - resume.from : size;
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expectedLength)) {
        return refuse('Le téléchargement TeraBox ne correspond pas à la taille annoncée.');
      }
      const type = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (type.includes('text/html') && !/\.html?$/i.test(fileName)) {
        await response.body.cancel(); throw new Error('TeraBox a renvoyé une page au lieu du fichier.');
      }
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) controller.close(); else controller.enqueue(part.value);
          } catch {
            controller.error(signal.aborted ? new DOMException('Transfert interrompu', 'AbortError') : new Error('Flux TeraBox interrompu.'));
          }
        },
        async cancel() { await reader.cancel().catch(() => undefined); },
      });
      return new Response(body, { status: response.status, ...(strongEtag(etag) ? { headers: { etag } } : {}) });
    }
    throw new Error('Trop de redirections TeraBox.');
  }
  /** Renvoie une adresse sensible uniquement au processus principal ; ne pas journaliser. */
  async fileMeta(path: string): Promise<{ path: string; name: string; size: number; url: string }> {
    remotePath(path);
    const data = new URLSearchParams({ dlink: '1', origin: 'dlna', target: JSON.stringify([path]) });
    const { value, region } = await this.request('/api/filemetas', 'POST', data);
    if (region) throw new Error('Session TeraBox à reconnecter.');
    apiError(value);
    if (!Array.isArray(value.info) || value.info.length !== 1) throw new Error('Fichier TeraBox introuvable.');
    const raw = record(value.info[0]);
    if (raw.path !== path || Number(raw.isdir) !== 0 || typeof raw.dlink !== 'string') throw new Error('Métadonnées TeraBox invalides.');
    const name = String(raw.server_filename ?? path.split('/').pop() ?? '');
    if (!name || /[\/\\\0]/.test(name)) throw new Error('Nom de fichier TeraBox invalide.');
    // Le lien sera validé avant toute requête CDN, jamais exposé à l'interface.
    return { path, name, size: numberValue(raw.size, 'taille'), url: raw.dlink };
  }
}
