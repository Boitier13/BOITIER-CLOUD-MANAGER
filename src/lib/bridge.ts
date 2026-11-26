/**
 * Pont vers le processus principal d'Electron.
 *
 * L'application reste consultable dans un navigateur : `window.boitier` est alors
 * absent, et l'interface affiche un état vide plutôt que des données inventées.
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
  /** Le compte était déjà connecté : la connexion l'a mis à jour. */
  alreadyConnected?: boolean;
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

/** Plan de téléchargement d'un dossier entier (métadonnées seules). */
export type GoogleFolderPlan = {
  files: { fileId: string; path: string; size: number; mimeType: string }[];
  folders: string[];
  /** Documents Google natifs écartés (pas de fichier binaire). */
  skipped: string[];
  /** La limite de sécurité a été atteinte : le lot est incomplet. */
  truncated: boolean;
  totalBytes: number;
};

/** Répartition du stockage d'un compte Google. */
export type GoogleStorageCategory = {
  id: 'document' | 'image' | 'video' | 'audio' | 'archive' | 'other';
  bytes: number;
  count: number;
  /** Somme incomplète : le plafond de pages a été atteint. */
  partial: boolean;
};

export type GoogleStorageUsage = {
  usedBytes: number;
  quotaBytes: number;
  /** Drive + Gmail + Photos moins Drive ; `null` si Google ne distingue pas. */
  emailBytes: number | null;
  categories: GoogleStorageCategory[];
  partial: boolean;
};

export type GoogleDownloadRequest = {
  id: string;
  accountId: string;
  fileId: string;
  name: string;
  size: number;
  dir?: string;
  /** Sous-dossier de `dir`, pour un téléchargement de dossier entier. */
  subPath?: string;
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
  /**
   * Signale à la fenêtre que l'interface est interactive. Absent dans un
   * navigateur : le pont entier l'est aussi.
   */
  ready?: () => Promise<unknown>;
  google: {
    status(): Promise<GoogleClientStatus>;
    setClient(clientId: string, clientSecret: string): Promise<GoogleClientStatus>;
    accounts(): Promise<GoogleAccountInfo[]>;
    connect(): Promise<GoogleAccountInfo>;
    disconnect(accountId: string): Promise<void>;
    list(accountId: string, folderId: string): Promise<GoogleFile[]>;
    search(accountId: string, term: string): Promise<GoogleFile[]>;
    /** Fichiers partagés avec ce compte, hors de ses propres dossiers. */
    shared(accountId: string): Promise<GoogleFile[]>;
    /** Parcourt un dossier et renvoie le plan de téléchargement, sans rien écrire. */
    plan(accountId: string, folderId: string): Promise<GoogleFolderPlan>;
    /** Quota exact + répartition mesurée par catégorie (bornée, parfois partielle). */
    storage(accountId: string): Promise<GoogleStorageUsage>;
    /**
     * Derniers fichiers **modifiés** (Google ne transmet pas les dates
     * d'ouverture). `days` borne la fenêtre, `limit` le volume.
     */
    recent(
      accountId: string,
      options?: { days?: number; limit?: number },
    ): Promise<GoogleFile[]>;
    download(request: GoogleDownloadRequest): Promise<void>;
    pause(id: string): Promise<void>;
    resume(id: string, accountId: string): Promise<boolean>;
    cancel(id: string): Promise<void>;
    refresh(accountId: string): Promise<GoogleAccountInfo | null>;
    /** Dossier du système utilisé par défaut (peut manquer côté aperçu). */
    folder?(): Promise<string>;
    /** Boîte de dialogue du système : dossier de destination choisi. */
    chooseFolder?(): Promise<string | null>;
    onDownload(listener: (event: GoogleDownloadEvent) => void): () => void;
    /** Révèle un fichier dans l'explorateur Windows. */
    openFolder?(path: string): Promise<void>;
    openExternal?(url: string): Promise<boolean>;
    /** Ouvre un dossier dans l'explorateur de fichiers. */
    openDirectory?(path: string): Promise<boolean>;
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

/**
 * Annonce que l'interface est montée et répond aux clics.
 *
 * Le processus principal attend ce signal : sans lui, il recharge la fenêtre
 * une fois puis affiche un message, plutôt que de laisser un cadre inerte.
 * L'appel est sans effet dans un navigateur et ne lève jamais.
 */
export function signalReady(): void {
  const bridge = getBridge();
  if (!bridge?.ready) return;
  try {
    void Promise.resolve(bridge.ready()).catch(() => undefined);
  } catch {
    /* le signal est un confort de diagnostic : jamais bloquant */
  }
}
