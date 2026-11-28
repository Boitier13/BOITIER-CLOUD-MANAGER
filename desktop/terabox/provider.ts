/** Contrat de lecture indépendant du protocole TeraBox.
 * Une future API officielle devra implémenter ce contrat, mais ses
 * identifiants et ses permissions seront vérifiés séparément : aucune
 * équivalence de compte ou de chemin n'est supposée ici.
 */
export interface TeraBoxEntry {
  path: string;
  name: string;
  directory: boolean;
  size: number;
  modified: string;
}

export interface TeraBoxReader {
  identity(): Promise<string>;
  quota(): Promise<{ usedBytes: number; quotaBytes: number }>;
  list(path: string): Promise<TeraBoxEntry[]>;
  search(query: string): Promise<TeraBoxEntry[]>;
  fileMeta?(path: string): Promise<{ path: string; name: string; size: number; url: string }>;
  openContent?(url: string, size: number, fileName: string, signal: AbortSignal): Promise<Response>;
}

/** Fabrique pour la méthode provisoire ; un futur flux officiel utilisera
 * une fabrique et des secrets distincts. Ne jamais lui donner un cookie Web. */
export type WebReaderFactory = (session: string) => TeraBoxReader;
