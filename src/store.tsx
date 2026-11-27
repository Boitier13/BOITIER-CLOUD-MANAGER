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
import { interruptStaleDownloads, isLegacyDownloadFolder } from './lib/transfers';
import { flattenTree, type TreeEntry } from './lib/tree';
import { chrono, marquerPhase } from './lib/trace';
import { remoteCatalog, remoteTree } from './lib/remote';
import { getBridge } from './lib/bridge';
import {
  cancelTransfer,
  pauseTransfer,
  registerAccountProviders,
  resumeTransfer,
} from './lib/cloud';
import {
  isRealAccount,
  noteJournal,
  realAccountId,
  syncGoogleAccounts,
} from './lib/google';
import { mergeSyncedAccounts, normalizeAccounts } from './lib/accountSync';

/* ----------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

export type Route =
  | { name: 'home' }
  | { name: 'clouds'; provider: ProviderId }
  | { name: 'files' }
  | { name: 'search' }
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
  /**
   * Facteur d'agrandissement de l'interface (1 = 100 %).
   *
   * Appliqué au zoom de la fenêtre, donc à tout — texte, icônes, marges — et
   * conservé d'une session à l'autre. C'est ce qui manquait : Ctrl+« + »
   * s'oubliait à chaque redémarrage.
   */
  textScale: number;
  downloadFolder: string;
  concurrent: number;
  confirmDelete: boolean;
  /**
   * Ranger chaque transfert dans `<base>\<cloud>\<nature>` — par exemple
   * `…\Downloads\Google Drive\Vidéos` — au lieu de tout mettre dans un
   * dossier unique où tout se mélange.
   */
  organizeDownloads: boolean;
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
  /** Plusieurs comptes en une seule action (MEGA : onze comptes au démarrage). */
  | { type: 'account/addMany'; accounts: Account[] }
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

/**
 * Nombre de transferts terminés conservés dans l'historique. Au-delà, l'état
 * grossit à chaque téléchargement et chaque rendu avec lui.
 */
const HISTORIQUE_MAX = 50;

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  // 110 % par défaut : les petites tailles de l'interface restaient justes.
  textScale: 1.1,
  // Vide = dossier de téléchargements du système (résolu par le processus
  // principal). Un chemin Windows en dur ne valait que pour une machine.
  downloadFolder: '',
  concurrent: 3,
  confirmDelete: true,
  organizeDownloads: true,
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
    const accounts = normalizeAccounts(
      parsed.accounts.filter(
        (account): account is Account =>
          !!account &&
          (account.source === 'google' || account.source === 'mega' || account.source === 'shadow' || account.source === 'terabox') &&
          !!PROVIDERS[account.provider] &&
          typeof account.id === 'string',
      ),
    );
    if (!accounts.length) return initial;

    const accountIds = new Set(accounts.map((account) => account.id));
    const favorites = (parsed.favorites ?? []).filter((fav) => accountIds.has(fav.accountId));
    const downloads = interruptStaleDownloads(
      (parsed.downloads ?? []).filter((item) => item && accountIds.has(item.accountId)),
    );
    const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
    // Ancien dossier inventé (`D:\Médias\Téléchargements`…) : retour au
    // dossier du système plutôt qu'un chemin qui n'existe pas.
    if (isLegacyDownloadFolder(settings.downloadFolder)) settings.downloadFolder = '';
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
  // Un identifiant appartient à un fournisseur : jamais l'un à la place de
  // l'autre. Sans ce garde-fou, une synchronisation pouvait convertir un compte
  // Google en compte MEGA (et inversement) quand les deux partageaient la même
  // adresse.
  if (previous.provider !== next.provider) return previous;
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
    merged.megaId === previous.megaId &&
    merged.shadowId === previous.shadowId &&
    merged.teraboxId === previous.teraboxId &&
    merged.shadowUrl === previous.shadowUrl &&
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

    case 'account/addMany': {
      // Une action, un rendu. Onze dispatches successifs pour onze comptes MEGA
      // provoquaient onze passages de rendu au montage de l'écran.
      let accounts = state.accounts;
      let modifie = false;
      for (const account of action.accounts) {
        const index = accounts.findIndex((item) => item.id === account.id);
        if (index < 0) {
          if (accounts === state.accounts) accounts = [...state.accounts];
          accounts.push(account);
          modifie = true;
          continue;
        }
        const fusionne = mergeAccount(accounts[index], account);
        if (fusionne === accounts[index]) continue;
        if (accounts === state.accounts) accounts = [...state.accounts];
        accounts[index] = fusionne;
        modifie = true;
      }
      return modifie ? { ...state, accounts } : state;
    }

    case 'account/sync': {
      // Les comptes Google reflètent le coffre chiffré ; les autres fournisseurs
      // (MEGA) ne sont **pas** concernés par cette synchronisation et doivent
      // survivre tels quels.
      //
      // La condition précédente retirait tout compte « réel » absent du coffre
      // Google : depuis que MEGA est un fournisseur réel, elle effaçait les
      // comptes MEGA à chaque démarrage. Elle ne filtre plus que les comptes
      // Google.
      // La fusion (et la règle de retrait) vit dans `lib/accountSync.ts` : elle
      // est vérifiée par un test, parce qu'une condition trop large y effaçait
      // les comptes MEGA à chaque démarrage.
      const fusionnes = action.accounts.map((account) => {
        const courant = state.accounts.find((item) => item.id === account.id);
        return courant ? mergeAccount(courant, account) : account;
      });
      const accounts = mergeSyncedAccounts(state.accounts, fusionnes);
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
      // Aucune révocation ici : un reducer doit rester pur, et React peut
      // l'exécuter plusieurs fois pour une même action. C'est le bouton de
      // déconnexion qui révoque (`useDisconnect` dans Cloud.tsx), avant de
      // dispatcher cette action.
      const remaining = state.accounts.filter((account) => account.id !== action.id);
      return {
        ...state,
        accounts: remaining,
        favorites: state.favorites.filter((fav) => fav.accountId !== action.id),
        downloads: state.downloads.filter(
          (item) => item.accountId !== action.id || item.status === 'done',
        ),
        explorer:
          state.explorer.accountId === action.id
            ? { accountId: remaining[0]?.id ?? '', path: [], view: 'files' as const, history: [] }
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

    case 'downloads/add': {
      const tous = [...action.items, ...state.downloads];
      // Historique borné : les transferts terminés ne sont gardés qu'en nombre
      // limité, les transferts en cours ne le sont jamais. Un état qui grossit
      // sans fin alourdit chaque rendu, chaque sauvegarde et chaque écriture.
      let gardes = 0;
      const downloads = tous.filter((item) => {
        if (item.status === 'active' || item.status === 'queued' || item.status === 'paused') {
          return true;
        }
        gardes += 1;
        return gardes <= HISTORIQUE_MAX;
      });
      return { ...state, downloads };
    }

    case 'downloads/pause': {
      const target = state.downloads.find((item) => item.id === action.id);
      if (target?.remoteId) void pauseTransfer(target.provider ?? 'gdrive', action.id);
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
      if (target?.remoteId) {
        void resumeTransfer(target.provider ?? 'gdrive', action.id, target.remoteAccount).catch(
          () => undefined,
        );
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
        void cancelTransfer(target.provider ?? 'gdrive', action.id);
      }
      return {
        ...state,
        downloads: state.downloads.filter((item) => item.id !== action.id),
      };
    }

    case 'downloads/progress': {
      if (!action.updates.length) return state;
      const byId = new Map(action.updates.map((update) => [update.id, update]));
      let touche = false;
      const rafraichis = state.downloads.map((item) => {
          const update = byId.get(item.id);
          if (!update) return item;
          touche = true;
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
            size: update.size,
            speed: update.speed,
            ...(update.path ? { savedPath: update.path } : {}),
            ...(update.message ? { error: update.message } : {}),
            // Une relance efface le motif d'échec précédent.
            ...(status === 'active' ? { error: undefined } : {}),
            ...(status === 'done'
              ? { completedAt: new Date().toISOString(), error: undefined }
              : {}),
          } satisfies DownloadItem;
      });
      // Événement sans destinataire (transfert retiré entre-temps) : aucun rendu.
      return touche ? { ...state, downloads: rafraichis } : state;
    }

    case 'downloads/pauseAll': {
      for (const item of state.downloads) {
        if (item.remoteId && item.status === 'active') {
          void pauseTransfer(item.provider ?? 'gdrive', item.id);
        }
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
      return {
        ...state,
        downloads: state.downloads.map((item) => {
          if (item.status !== 'paused') return item;
          if (item.remoteId) {
            void resumeTransfer(item.provider ?? 'gdrive', item.id, item.remoteAccount).catch(
              () => undefined,
            );
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

  // Les identifiants de comptes MEGA sont opaques : l'aiguillage des appels a
  // besoin de savoir à quel fournisseur ils appartiennent. Simple mise à jour
  // d'un registre en mémoire, déclenchée uniquement par un changement de
  // comptes — aucun minuteur, aucune écriture d'état.
  registerAccountProviders(state.accounts);


  // Référence à jour pour les effets qui n'ont pas besoin de se réabonner.
  const stateRef = useRef(state);
  stateRef.current = state;

  // File de téléchargements : le minuteur ne tourne que s'il reste quelque
  // chose à faire avancer. Un intervalle permanent réveillait l'application
  // toutes les 900 ms même sans le moindre transfert en cours — et un seul
  // transfert terminé suffisait à le maintenir indéfiniment.
  const fileAnimee = state.downloads.some(
    (item) => item.status === 'queued' || (item.status === 'active' && !item.remoteId),
  );
  useEffect(() => {
    if (!fileAnimee) return;
    const timer = window.setInterval(() => {
      dispatch({ type: 'downloads/tick', elapsed: 900 });
    }, 900);
    return () => window.clearInterval(timer);
  }, [fileAnimee]);

  /**
   * Comptes Google réels : la source de vérité est le coffre chiffré du
   * processus principal. On ne fait que refléter ici ce qu'il contient.
   */
  useEffect(() => {
    const bridge = getBridge();
    if (!bridge) return;
    let cancelled = false;

    /**
     * Synchronisation du coffre vers l'écran, avec réessais.
     *
     * Un appel qui échoue au démarrage — processus principal encore occupé,
     * canal pas encore prêt — laissait l'écran en l'état : les comptes du
     * coffre n'apparaissaient pas, et rien ne le signalait. On réessaie donc
     * quelques fois, on note le résultat, et on retente au retour de la fenêtre.
     */
    const tenter = async (essai: number): Promise<boolean> => {
      try {
        const { received } = await syncGoogleAccounts(
          stateRef.current.accounts,
          (action) => dispatch(action),
        );
        if (!cancelled && essai > 0) {
          noteJournal(`comptes : coffre relu au ${essai + 1}ᵉ essai · ${received} reçu(s)`);
        }
        return true;
      } catch (cause) {
        if (!cancelled) {
          const message = cause instanceof Error ? cause.message : String(cause);
          noteJournal(`comptes : lecture du coffre échouée (${message}) · essai ${essai + 1}`);
        }
        return false;
      }
    };

    const delais = [0, 400, 1200, 2500, 5000];
    void (async () => {
      for (let essai = 0; essai < delais.length; essai += 1) {
        if (cancelled) return;
        if (delais[essai]) await new Promise((resolve) => setTimeout(resolve, delais[essai]));
        if (cancelled) return;
        if (await tenter(essai)) return;
      }
    })();

    // Retour de la fenêtre : une seule lecture, pas de réveil périodique.
    const auRetour = () => {
      if (document.visibilityState === 'visible' && !cancelled) void tenter(0);
    };
    document.addEventListener('visibilitychange', auRetour);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', auRetour);
    };
    // Ne dépend d'aucun état : la synchronisation est déclenchée explicitement.
  }, []);

  /**
   * Nombre de comptes Google réellement à l'écran, noté dès qu'il change.
   *
   * C'est la ligne qui manquait : « 9 relus dans le coffre, 2 affichés » se lit
   * désormais au lieu de se deviner.
   */
  const googleAffiches = state.accounts.filter(
    (account) => account.provider === 'gdrive' && isRealAccount(account),
  ).length;
  const googleNote = useRef(-1);
  useEffect(() => {
    if (googleNote.current === googleAffiches) return;
    googleNote.current = googleAffiches;
    noteJournal(`comptes : ${googleAffiches} compte(s) Google à l'écran`);
  }, [googleAffiches]);

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

  // Thème appliqué à la racine du document.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.settings.theme;
    root.style.colorScheme = state.settings.theme;
  }, [state.settings.theme]);

  // Taille du texte : zoom de la fenêtre côté application Windows, repli CSS
  // dans l'aperçu navigateur. Sans cela, le réglage serait perdu à la fermeture.
  useEffect(() => {
    const scale = state.settings.textScale;
    const bridge = getBridge();
    if (bridge?.setZoom) {
      void bridge.setZoom(scale).catch(() => undefined);
      return;
    }
    document.documentElement.style.zoom = String(scale);
  }, [state.settings.textScale]);

  /**
   * Signature *structurelle* de la file : identifiant et état, sans
   * l'avancement. La progression d'un transfert change plusieurs fois par
   * seconde et n'a aucune raison d'être écrite sur le disque — au redémarrage,
   * un transfert interrompu est de toute façon marqué comme tel et repart de
   * zéro. Dépendre de `state.downloads` réécrivait donc tout l'état local à
   * chaque point de progression, sur le fil de l'interface.
   */
  const fileStructure = state.downloads.map((item) => `${item.id}:${item.status}`).join('|');

  // Sauvegarde locale différée (aucun serveur).
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // Une sérialisation d'état est synchrone : elle mérite d'être nommée si
      // un figement tombe pendant qu'elle s'écrit.
      marquerPhase('écriture de l’état local');
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
      marquerPhase('au repos');
    }, 600);
    return () => window.clearTimeout(timer);
  }, [
    state.accounts,
    state.favorites,
    fileStructure,
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

// App et plusieurs écrans utilisent le même catalogue : un seul calcul par
// révision, partagé entre les composants au lieu d'aplatir chaque fois.
let catalogueMemorise: {
  accounts: AppState['accounts'];
  revision: number;
  view: AppState['explorer']['view'];
  accountId: string;
  value: Catalog;
} | undefined;

export function useCatalog(): Catalog {
  const { state } = useStore();
  // Les comptes réels alimentent ce catalogue au fil des dossiers chargés :
  // la révision distante sert de signal de recalcul.
  const remoteRevision = useSyncExternalStore(
    remoteCatalog.subscribe,
    () => remoteCatalog.revision,
  );
  return useMemo(() => {
    if (catalogueMemorise && catalogueMemorise.accounts === state.accounts &&
        catalogueMemorise.revision === remoteRevision &&
        catalogueMemorise.view === state.explorer.view &&
        catalogueMemorise.accountId === state.explorer.accountId) return catalogueMemorise.value;
    const value = chrono('catalogue local', () => {
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
    });
    catalogueMemorise = {
      accounts: state.accounts, revision: remoteRevision, view: state.explorer.view,
      accountId: state.explorer.accountId, value,
    };
    return value;
  }, [state.accounts, remoteRevision, state.explorer.view, state.explorer.accountId]);
}

export function accountById(state: AppState, id: string): Account | undefined {
  return state.accounts.find((account) => account.id === id);
}

export function providerAccounts(state: AppState, provider: ProviderId): Account[] {
  return state.accounts.filter((account) => account.provider === provider);
}

