import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  PROVIDERS,
  type Account,
  type AccountStatus,
  type FileNode,
  type ProviderId,
} from './data/catalog';
import { advanceDownloads, type DownloadItem } from './lib/downloads';
import { flattenTree, type TreeEntry } from './lib/tree';
import { remoteCatalog, remoteTree } from './lib/remote';
import { getBridge } from './lib/bridge';
import { isRealAccount, probeAccounts, realAccountId, toAccount } from './lib/google';

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export type Route =
  | { name: 'home' }
  | { name: 'clouds'; provider: ProviderId }
  | { name: 'files' }
  | { name: 'downloads' }
  | { name: 'favorites' }
  | { name: 'storage' }
  | { name: 'recent' }
  | { name: 'settings' };

export interface Favorite {
  accountId: string;
  path: string[];
  addedAt: string;
}

export interface Settings {
  theme: 'dark' | 'light';
  density: 'confort' | 'compact';
  downloadFolder: string;
  concurrent: number;
  confirmDelete: boolean;
}

export interface ExplorerState {
  accountId: string;
  path: string[];
  /** `files` : dossiers du compte. `shared` : ce que d'autres ont partagé. */
  view: ExplorerView;
  history: { accountId: string; path: string[]; view: ExplorerView }[];
}

/**
 * Sous-vue de l'explorateur. `files` = les dossiers du compte ; `shared` = les
 * fichiers que d'autres personnes ont partagés avec lui. Ces derniers ne vivent
 * dans aucun dossier de l'utilisateur : ils méritent leur propre vue.
 */
export type ExplorerView = 'files' | 'shared';

export interface AppState {
  accounts: Account[];
  favorites: Favorite[];
  downloads: DownloadItem[];
  settings: Settings;
  route: Route;
  explorer: ExplorerState;
  revision: number;
}

export type Action =
  | { type: 'route'; route: Route }
  | { type: 'account/upsert'; account: Account }
  | { type: 'account/sync'; accounts: Account[] }
  | {
      type: 'account/patch';
      id: string;
      name?: string;
      email?: string;
      status?: AccountStatus;
      /** Chiffres fraîchement relus chez Google (bouton « actualiser »). */
      usedBytes?: number;
      quotaBytes?: number;
    }
  | { type: 'account/remove'; id: string }
  | { type: 'favorite/toggle'; accountId: string; path: string[] }
  | { type: 'favorite/remove'; accountId: string; path: string[] }
  | { type: 'downloads/add'; items: DownloadItem[] }
  | { type: 'downloads/pause'; id: string }
  | { type: 'downloads/resume'; id: string }
  | { type: 'downloads/cancel'; id: string }
  | { type: 'downloads/pauseAll' }
  | { type: 'downloads/resumeAll' }
  | { type: 'downloads/clearDone' }
  | { type: 'downloads/tick'; elapsed: number }
  | {
      type: 'downloads/progress';
      updates: {
        id: string;
        status: 'running' | 'paused' | 'done' | 'error';
        received: number;
        size: number;
        speed: number;
        path?: string;
        message?: string;
      }[];
    }
  | { type: 'settings/patch'; patch: Partial<Settings> }
  | { type: 'explorer/open'; accountId: string; path?: string[] }
  | { type: 'explorer/chooseAccount'; accountId: string }
  | { type: 'explorer/enter'; name: string }
  | { type: 'explorer/back' }
  | { type: 'explorer/root' }
  | { type: 'explorer/view'; view: ExplorerView; accountId?: string }
  | { type: 'data/reset' };

/* ----------------------------------------------------------------------------
 * État initial + persistance locale
 * ------------------------------------------------------------------------- */

const STORAGE_KEY = 'boitier-cloud-manager:v1';

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  density: 'confort',
  downloadFolder: 'C:\\Users\\Boitier\\Téléchargements',
  concurrent: 3,
  confirmDelete: true,
};

export function createEmptyState(): AppState {
  // Aucun compte fictif : l'application démarre vide et propose de connecter
  // un compte réel. Les écrans doivent tous gérer cet état.
  return {
    accounts: [],
    favorites: [],
    downloads: [],
    settings: DEFAULT_SETTINGS,
    route: { name: 'home' },
    explorer: { accountId: '', path: [], view: 'files', history: [] },
    revision: 0,
  };
}

function loadState(): AppState {
  const initial = createEmptyState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initial;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!parsed || !Array.isArray(parsed.accounts)) return initial;

    // Migration : les versions précédentes enregistraient des comptes de
    // démonstration. Ils sont écartés — seuls les comptes réellement connectés
    // à un fournisseur subsistent. Leur arborescence fictive disparaît avec eux.
    const accounts = parsed.accounts.filter(
      (account): account is Account =>
        !!account &&
        account.source === 'google' &&
        !!PROVIDERS[account.provider] &&
        typeof account.id === 'string',
    );
    if (!accounts.length) return initial;

    const accountIds = new Set(accounts.map((account) => account.id));
    const favorites = (parsed.favorites ?? []).filter((fav) => accountIds.has(fav.accountId));
    const downloads = (parsed.downloads ?? []).filter(
      (item) => item && accountIds.has(item.accountId),
    );
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
    const activeAccount = accounts.find((a) => a.id === parsed.explorer?.accountId);

    return {
      accounts,
      favorites,
      downloads,
      settings,
      route: { name: 'home' },
      explorer: {
        accountId: activeAccount?.id ?? accounts[0].id,
        path: [],
        view: 'files',
        history: [],
      },
      revision: 0,
    };
  } catch {
    return initial;
  }
}

/* ----------------------------------------------------------------------------
 * Reducer
 * ------------------------------------------------------------------------- */

const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

/** Fusion d'un compte synchronisé : on ignore les valeurs identiques. */
function mergeAccount(previous: Account | undefined, next: Account): Account {
  if (!previous) return next;
  const merged: Account = { ...previous, ...next };
  const identical =
    merged.name === previous.name &&
    merged.email === previous.email &&
    merged.status === previous.status &&
    merged.usedBytes === previous.usedBytes &&
    merged.quotaBytes === previous.quotaBytes &&
    merged.avatarUrl === previous.avatarUrl &&
    merged.source === previous.source &&
    merged.googleId === previous.googleId &&
    merged.localTree === previous.localTree;
  return identical ? previous : merged;
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'route':
      return { ...state, route: action.route };

    case 'account/upsert': {
      const exists = state.accounts.some((item) => item.id === action.account.id);
      return {
        ...state,
        accounts: exists
          ? state.accounts.map((item) =>
              item.id === action.account.id ? { ...item, ...action.account } : item,
            )
          : [...state.accounts, action.account],
      };
    }

    case 'account/sync': {
      // Les comptes Google reflètent le coffre chiffré ; les comptes fictifs
      // (y compris ceux de démonstration de Google Drive) sont conservés.
      const next = [...state.accounts];
      for (const account of action.accounts) {
        const index = next.findIndex((item) => item.id === account.id);
        if (index >= 0) next[index] = mergeAccount(next[index], account);
        else next.push(account);
      }
      const realIds = new Set(action.accounts.map((account) => account.id));
      const accounts = next.filter(
        (account) => !isRealAccount(account) || realIds.has(account.id),
      );
      if (accounts.length === state.accounts.length &&
          accounts.every((account, index) => account === state.accounts[index])) {
        return state;
      }
      // L'explorateur suit la liste : sans compte au départ, il n'avait aucune
      // sélection. Dès qu'un compte apparaît, il s'ouvre dessus ; s'il a disparu,
      // on bascule sur le premier restant.
      const stillThere = accounts.some((account) => account.id === state.explorer.accountId);
      const explorer = stillThere
        ? state.explorer
        : accounts.length
          ? { accountId: accounts[0].id, path: [], view: 'files' as const, history: [] }
          : { accountId: '', path: [], view: 'files' as const, history: [] };
      return { ...state, accounts, explorer };
    }

    case 'account/patch':
      return {
        ...state,
        accounts: state.accounts.map((account) =>
          account.id === action.id
            ? {
                ...account,
                ...(action.name !== undefined ? { name: action.name } : {}),
                ...(action.email !== undefined ? { email: action.email } : {}),
                ...(action.status !== undefined ? { status: action.status } : {}),
                ...(action.usedBytes !== undefined ? { usedBytes: action.usedBytes } : {}),
                ...(action.quotaBytes !== undefined && action.quotaBytes > 0
                  ? { quotaBytes: action.quotaBytes }
                  : {}),
              }
            : account,
        ),
        revision: state.revision + 1,
      };

    case 'account/remove': {
      const removed = state.accounts.find((account) => account.id === action.id);
      if (removed && isRealAccount(removed)) {
        const googleId = realAccountId(removed);
        if (googleId) void getBridge()?.google.disconnect(googleId);
      }
      const remaining = state.accounts.filter((account) => account.id !== action.id);
      if (remaining.length === 0) return state;
      return {
        ...state,
        accounts: remaining,
        favorites: state.favorites.filter((fav) => fav.accountId !== action.id),
        downloads: state.downloads.filter(
          (item) => item.accountId !== action.id || item.status === 'done',
        ),
        explorer:
          state.explorer.accountId === action.id
            ? { accountId: remaining[0].id, path: [], view: 'files' as const, history: [] }
            : state.explorer,
        revision: state.revision + 1,
      };
    }

    case 'favorite/toggle': {
      const exists = state.favorites.some(
        (fav) => fav.accountId === action.accountId && samePath(fav.path, action.path),
      );
      return {
        ...state,
        favorites: exists
          ? state.favorites.filter(
              (fav) => !(fav.accountId === action.accountId && samePath(fav.path, action.path)),
            )
          : [
              {
                accountId: action.accountId,
                path: action.path,
                addedAt: new Date().toISOString(),
              },
              ...state.favorites,
            ],
      };
    }

    case 'favorite/remove':
      return {
        ...state,
        favorites: state.favorites.filter(
          (fav) => !(fav.accountId === action.accountId && samePath(fav.path, action.path)),
        ),
      };

    case 'downloads/add':
      return { ...state, downloads: [...action.items, ...state.downloads] };

    case 'downloads/pause': {
      const target = state.downloads.find((item) => item.id === action.id);
      if (target?.remoteId) void getBridge()?.google.pause(action.id);
      return {
        ...state,
        downloads: state.downloads.map((item) =>
          item.id === action.id && (item.status === 'active' || item.status === 'queued')
            ? { ...item, status: 'paused', speed: 0 }
            : item,
        ),
      };
    }

    case 'downloads/resume': {
      const target = state.downloads.find((item) => item.id === action.id);
      if (target?.remoteId && target.remoteAccount) {
        void getBridge()
          ?.google.resume(action.id, target.remoteAccount)
          .catch(() => undefined);
      }
      return {
        ...state,
        downloads: state.downloads.map((item) =>
          item.id === action.id && (item.status === 'paused' || item.status === 'queued')
            ? { ...item, status: 'queued' }
            : item,
        ),
      };
    }

    case 'downloads/cancel': {
      const target = state.downloads.find((item) => item.id === action.id);
      if (target?.remoteId) {
        void getBridge()?.google.cancel(action.id);
      }
      return {
        ...state,
        downloads: state.downloads.filter((item) => item.id !== action.id),
      };
    }

    case 'downloads/progress': {
      if (!action.updates.length) return state;
      const byId = new Map(action.updates.map((update) => [update.id, update]));
      return {
        ...state,
        downloads: state.downloads.map((item) => {
          const update = byId.get(item.id);
          if (!update) return item;
          const status: DownloadItem['status'] =
            update.status === 'running'
              ? 'active'
              : update.status === 'paused'
                ? 'paused'
                : update.status === 'done'
                  ? 'done'
                  : 'error';
          return {
            ...item,
            status,
            received: update.received,
            size: update.size || item.size,
            speed: update.speed,
            ...(update.path ? { savedPath: update.path } : {}),
            ...(update.message ? { error: update.message } : {}),
            ...(status === 'done'
              ? { completedAt: new Date().toISOString(), error: undefined }
              : {}),
          } satisfies DownloadItem;
        }),
      };
    }

    case 'downloads/pauseAll': {
      const bridge = getBridge();
      for (const item of state.downloads) {
        if (item.remoteId && item.status === 'active') void bridge?.google.pause(item.id);
      }
      return {
        ...state,
        downloads: state.downloads.map((item) =>
          item.status === 'active' || item.status === 'queued'
            ? { ...item, status: 'paused', speed: 0 }
            : item,
        ),
      };
    }

    case 'downloads/resumeAll': {
      const bridge = getBridge();
      return {
        ...state,
        downloads: state.downloads.map((item) => {
          if (item.status !== 'paused') return item;
          if (item.remoteId && item.remoteAccount) {
            void bridge?.google.resume(item.id, item.remoteAccount).catch(() => undefined);
            return { ...item, status: 'active' as const };
          }
          return { ...item, status: 'queued' as const };
        }),
      };
    }

    case 'downloads/clearDone':
      return {
        ...state,
        downloads: state.downloads.filter((item) => item.status !== 'done'),
      };

    case 'downloads/tick':
      if (state.downloads.length === 0) return state;
      return {
        ...state,
        downloads: advanceDownloads(state.downloads, state.settings.concurrent, action.elapsed),
      };

    case 'settings/patch':
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case 'explorer/open': {
      const target = {
        accountId: action.accountId,
        path: action.path ?? [],
        view: 'files' as const,
      };
      const sameAccount = state.explorer.accountId === target.accountId;
      // On n'empile un point d'historique que pour un vrai déplacement
      // (changement de dossier ou de compte), jamais pour rouvrir la même vue.
      const moved =
        !sameAccount || !samePath(state.explorer.path, target.path);
      const history = !sameAccount
        ? [
            {
              accountId: state.explorer.accountId,
              path: state.explorer.path,
              view: state.explorer.view,
            },
          ]
        : moved
          ? [
              ...state.explorer.history,
              {
                accountId: state.explorer.accountId,
                path: state.explorer.path,
                view: state.explorer.view,
              },
            ]
          : state.explorer.history;
      return { ...state, explorer: { ...target, history }, route: { name: 'files' } };
    }

    case 'explorer/chooseAccount':
      return {
        ...state,
        explorer: { accountId: action.accountId, path: [], view: 'files', history: [] },
        route: { name: 'files' },
      };

    case 'explorer/enter':
      return {
        ...state,
        explorer: {
          ...state.explorer,
          history: [
            ...state.explorer.history,
            {
              accountId: state.explorer.accountId,
              path: state.explorer.path,
              // Revenir en arrière réaffiche la vue d'où l'on vient.
              view: state.explorer.view,
            },
          ],
          path: [...state.explorer.path, action.name],
          // Un dossier ouvert (y compris depuis « Partagés avec moi ») s'affiche
          // comme un dossier ordinaire : le fil d'Ariane redevient un chemin.
          view: 'files',
        },
      };

    case 'explorer/back': {
      const previous = state.explorer.history[state.explorer.history.length - 1];
      if (!previous) return state;
      return {
        ...state,
        explorer: {
          accountId: previous.accountId,
          path: previous.path,
          view: previous.view ?? 'files',
          history: state.explorer.history.slice(0, -1),
        },
      };
    }

    case 'explorer/root':
      return {
        ...state,
        explorer: { ...state.explorer, history: [], path: [], view: 'files' },
      };

    case 'explorer/view': {
      const accountId = action.accountId ?? state.explorer.accountId;
      const changed =
        accountId !== state.explorer.accountId || action.view !== state.explorer.view;
      const history = changed
        ? [
            ...state.explorer.history,
            {
              accountId: state.explorer.accountId,
              path: state.explorer.path,
              view: state.explorer.view,
            },
          ]
        : state.explorer.history;
      return {
        ...state,
        explorer: { accountId, path: [], view: action.view, history },
        route: { name: 'files' },
      };
    }

    case 'data/reset':
      return createEmptyState();

    default:
      return state;
  }
}

/* ----------------------------------------------------------------------------
 * Contexte
 * ------------------------------------------------------------------------- */

interface StoreValue {
  state: AppState;
  dispatch: Dispatch<Action>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);

  // Référence à jour pour les effets qui n'ont pas besoin de se réabonner.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Simulation de la file de téléchargements.
  useEffect(() => {
    const timer = window.setInterval(() => {
      dispatch({ type: 'downloads/tick', elapsed: 900 });
    }, 900);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * Comptes Google réels : la source de vérité est le coffre chiffré du
   * processus principal. On ne fait que refléter ici ce qu'il contient.
   */
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;

    const sync = async () => {
      const infos = await probeAccounts();
      if (cancelled) return;
      dispatch({
        type: 'account/sync',
        accounts: infos.map((info) =>
          toAccount(
            info,
            stateRef.current.accounts.find(
              (account) =>
                isRealAccount(account) && account.googleId === info.accountId,
            ) ?? stateRef.current.accounts.find(
              (account) =>
                account.provider === 'gdrive' && account.email === info.email,
            ),
          ),
        ),
      });
    };

    void sync();
    return () => {
      cancelled = true;
    };
    // Ne dépend d'aucun état : la synchronisation est déclenchée explicitement.
  }, []);

  // Progression réelle des transferts pilotés par le processus principal.
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    const stop = bridge.google.onDownload((event) => {
      dispatch({
        type: 'downloads/progress',
        updates: [
          {
            id: event.id,
            status: event.status,
            received: event.received,
            size: event.size,
            speed: event.speed,
            ...(event.path ? { path: event.path } : {}),
            ...(event.message ? { message: event.message } : {}),
          },
        ],
      });
    });
    return stop;
  }, []);

  // Thème + densité appliqués à la racine du document.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme;
    root.dataset.density = state.settings.density;
    root.style.colorScheme = state.settings.theme;
  }, [state.settings.theme, state.settings.density]);

  // Sauvegarde locale différée (aucun serveur) : la simulation met à jour la
  // file en continu, on évite donc d'écrire dans le stockage à chaque tick.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const payload = {
        version: 1,
        accounts: state.accounts,
        favorites: state.favorites,
        downloads: state.downloads,
        settings: state.settings,
        explorer: { accountId: state.explorer.accountId, path: state.explorer.path },
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      } catch {
        /* stockage indisponible : l'app continue de fonctionner en mémoire */
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    state.accounts,
    state.favorites,
    state.downloads,
    state.settings,
    state.explorer.accountId,
    state.explorer.path,
  ]);

  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const context = useContext(StoreContext);
  if (!context) throw new Error('useStore doit être utilisé dans StoreProvider');
  return context;
}

/* ----------------------------------------------------------------------------
 * Catalogue dérivé
 * ------------------------------------------------------------------------- */

export interface CatalogEntry {
  accountId: string;
  node: FileNode;
  path: string[];
  parentPath: string[];
}

export interface Catalog {
  trees: Record<string, FileNode[]>;
  entries: CatalogEntry[];
  byKey: Map<string, CatalogEntry>;
}

export function catalogKey(accountId: string, path: string[]): string {
  return `${accountId}::${path.join('/')}`;
}

export function useCatalog(): Catalog {
  const { state } = useStore();
  // Les comptes réels alimentent ce catalogue au fil des dossiers chargés :
  // la révision distante sert de signal de recalcul.
  const remoteRevision = useSyncExternalStore(
    remoteCatalog.subscribe,
    () => remoteCatalog.revision,
  );
  return useMemo(() => {
    const trees: Record<string, FileNode[]> = {};
    const entries: CatalogEntry[] = [];
    const byKey = new Map<string, CatalogEntry>();

    // Toutes les arborescences proviennent des dossiers déjà chargés depuis le
    // fournisseur (voir lib/remote.ts) : plus aucun catalogue fictif.
    // La vue « partagés » n'est pas un dossier : ses fichiers n'ont pas de
    // chemin. On les indexe à la racine du compte pour que la recherche, les
    // favoris et les compteurs les voient comme n'importe quel fichier.
    for (const account of state.accounts) {
      // Le catalogue distant est indexé par l'identifiant Google (voir
      // lib/remote.ts) ; l'arborescence reste rangée sous l'identifiant de
      // l'application, celui que manipulent les favoris et l'explorateur.
      const remoteId = realAccountId(account);
      const tree = remoteTree(remoteId ?? account.id, {
        includeShared: state.explorer.view === 'shared' && state.explorer.accountId === account.id,
      });
      trees[account.id] = tree;
      const flat: TreeEntry[] = flattenTree(tree);
      for (const entry of flat) {
        const catalogEntry: CatalogEntry = {
          accountId: account.id,
          node: entry.node,
          path: entry.path,
          parentPath: entry.parentPath,
        };
        entries.push(catalogEntry);
        byKey.set(catalogKey(account.id, entry.path), catalogEntry);
      }
    }

    return { trees, entries, byKey };
  }, [state.accounts, remoteRevision, state.explorer.view, state.explorer.accountId]);
}

export function accountById(state: AppState, id: string): Account | undefined {
  return state.accounts.find((account) => account.id === id);
}

export function providerAccounts(state: AppState, provider: ProviderId): Account[] {
  return state.accounts.filter((account) => account.provider === provider);
}

