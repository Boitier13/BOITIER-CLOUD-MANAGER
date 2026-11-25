/**
 * Pont vers le processus principal d'Electron.
 *
 * L'application reste utilisable dans un navigateur : `window.boitier` est alors
 * absent et toutes les fonctions distantes retombent sur la démonstration locale.
 * Aucun jeton ne transite par ce pont : il ne transporte que des métadonnées.
 */

export type GoogleAccountInfo = {
  accountId: string;
  name: string;
  email: string;
  picture?: string;
  usedBytes: number;
  quotaBytes: number;
  status: 'connected' | 'expired';
};

export type GoogleFile = {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  /** Type natif Drive (distingue les documents Google des fichiers binaires). */
  mimeType: string;
  size: number;
  modified: string;
  parentId?: string;
};

export type GoogleDownloadRequest = {
  id: string;
  accountId: string;
  fileId: string;
  name: string;
  size: number;
  dir?: string;
};

export type GoogleDownloadEvent = {
  id: string;
  status: 'running' | 'paused' | 'done' | 'error';
  received: number;
  size: number;
  speed: number;
  /** Emplacement réel du fichier une fois terminé. */
  path?: string;
  message?: string;
};

export type GoogleClientStatus = {
  configured: boolean;
  source: 'env' | 'store' | 'none';
  clientId?: string;
};

export interface BoitierBridge {
  platform: string;
  google: {
    status(): Promise<GoogleClientStatus>;
    setClient(clientId: string, clientSecret: string): Promise<GoogleClientStatus>;
    accounts(): Promise<GoogleAccountInfo[]>;
    connect(): Promise<GoogleAccountInfo>;
    disconnect(accountId: string): Promise<void>;
    list(accountId: string, folderId: string): Promise<GoogleFile[]>;
    search(accountId: string, term: string): Promise<GoogleFile[]>;
    download(request: GoogleDownloadRequest): Promise<void>;
    pause(id: string): Promise<void>;
    resume(id: string, accountId: string): Promise<boolean>;
    cancel(id: string): Promise<void>;
    refresh(accountId: string): Promise<GoogleAccountInfo | null>;
    folder(): Promise<string>;
    onDownload(listener: (event: GoogleDownloadEvent) => void): () => void;
    /** Révèle un fichier dans l'explorateur Windows. */
    openFolder?(path: string): Promise<void>;
    openExternal?(url: string): Promise<boolean>;
  };
}

declare global {
  interface Window {
    boitier?: BoitierBridge;
  }
}

/** Renvoie le pont Electron, ou `null` dans un navigateur. */
export function getBridge(): BoitierBridge | null {
  if (typeof window === 'undefined') return null;
  return window.boitier ?? null;
}

/** Vrai lorsque l'application tourne dans sa fenêtre Windows (Electron). */
export function isDesktop(): boolean {
  return getBridge() !== null;
}
