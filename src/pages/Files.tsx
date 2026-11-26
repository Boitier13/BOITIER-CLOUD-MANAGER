import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CloudOff,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Download,
  ExternalLink,
  Folder,
  FolderDown,
  FolderOpen,
  HardDrive,
  Home as HomeIcon,
  ListFilter,
  MousePointerClick,
  RotateCcw,
  Search,
  SearchX,
  Star,
  Users,
  X,
} from 'lucide-react';
import {
  detectType,
  PROVIDERS,
  PROVIDER_LIST,
  type Account,
  type FileNode,
} from '../data/catalog';
import { catalogKey, useCatalog, useStore } from '../store';
import { accountMark, shortAddress } from '../lib/accounts';
import { isRealAccount, realAccountId } from '../lib/google';
import {
  displaySegment,
  driveFolderId,
  ID_SEPARATOR,
  useReloadRemote,
  useRemoteFolder,
  useRemoteSearch,
  useRemoteShared,
} from '../lib/remote';
import {
  getBridge,
  type GoogleDownloadRequest,
  type GoogleFolderPlan,
} from '../lib/bridge';
import {
  formatBytes,
  formatDate,
  formatDecimal,
  formatRelative,
  normalize,
  plural,
} from '../lib/format';
import { getChildren } from '../lib/tree';
import { cloudFolder, downloadSubPath } from '../lib/organize';
import { driveFolderUrl } from '../lib/driveLinks';
import { Meter, TypeIcon } from '../components/visuals';
import { createDownload } from '../lib/downloads';
import { FolderDownloadDialog } from '../components/FolderDownloadDialog';
import { useToast } from '../components/toast';
import {
  Breadcrumbs,
  Checkbox,
  ProviderDot,
  SortMenu,
  TYPE_FILTERS,
  countForType,
  labelFor,
  type SortKey,
  type TypeFilter,
} from './explorer/Bits';

export function Files() {
  const { state, dispatch } = useStore();
  const catalog = useCatalog();
  const toast = useToast();

  const account = state.accounts.find((a) => a.id === state.explorer.accountId);
  const path = state.explorer.path;
  const remote = Boolean(account && isRealAccount(account));
  /**
   * Identifiant attendu par le pont Electron.
   *
   * Un compte porte deux identifiants : celui de l'application
   * (`gdrive-real-…`, qui nomme le compte et ses favoris) et celui de Google
   * (`gdrive-…`, qui interroge réellement l'API). Le catalogue distant est
   * indexé par l'identifiant Google, seul connu du processus principal :
   * lui envoyer l'autre produisait « Compte Google inconnu ».
   */
  const remoteId = account && isRealAccount(account) ? realAccountId(account) ?? null : null;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'name',
    dir: 'asc',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Dossier dont on prépare le téléchargement complet (dialogue ouvert). */
  const [folderTarget, setFolderTarget] = useState<{
    name: string;
    fileId: string;
    accountId: string;
    basePath: string[];
  } | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  /** Filtre du volet des comptes : avec dix comptes, la liste devient longue. */
  const [railQuery, setRailQuery] = useState('');
  const railMatches = useMemo(() => {
    const q = normalize(railQuery.trim());
    if (!q) return null;
    return new Set(
      state.accounts
        .filter(
          (acc) =>
            normalize(acc.name).includes(q) ||
            normalize(acc.email).includes(q),
        )
        .map((acc) => acc.id),
    );
  }, [railQuery, state.accounts]);

  const sharedView = state.explorer.view === 'shared';
  const remoteFolder = useRemoteFolder(remoteId, path, remote && !sharedView);
  // Les fichiers partagés ne sont dans aucun dossier de l'utilisateur : ils
  // viennent d'une requête dédiée (sharedWithMe), pas du parcours de la racine.
  const sharedState = useRemoteShared(remoteId, remote && sharedView);
  /** État distant de la vue affichée : dossier courant ou fichiers partagés. */
  const activeState = sharedView ? sharedState : remoteFolder;

  // Arrivée sur l'écran sans compte sélectionné (première connexion, compte
  // retiré) : on ouvre le premier compte disponible au lieu de laisser une
  // invite alors qu'un compte existe.
  useEffect(() => {
    if (account || state.accounts.length === 0) return;
    dispatch({ type: 'explorer/chooseAccount', accountId: state.accounts[0].id });
  }, [account, state.accounts, dispatch]);
  const remoteQuery = query.trim().length >= 2 ? query : '';
  const remoteSearchState = useRemoteSearch(remoteId, remoteQuery, remote);
  const reloadRemote = useReloadRemote();

  const children = useMemo(() => {
    if (!account) return [];
    if (sharedView) return sharedState?.nodes ?? [];
    if (isRealAccount(account)) return remoteFolder?.nodes ?? [];
    return getChildren(catalog.trees[account.id] ?? [], path) ?? [];
  }, [catalog.trees, account, path, remoteFolder, sharedView, sharedState]);

  // Nom lisible des segments réels : le chemin technique porte l'identifiant Drive.
  const cleanPath = useMemo(
    () => (remote ? path.map(displaySegment) : path),
    [path, remote],
  );

  const favoriteSet = useMemo(
    () => new Set(state.favorites.map((fav) => catalogKey(fav.accountId, fav.path))),
    [state.favorites],
  );

  // Recherche globale : tous les comptes, avec l'emplacement réel de chaque résultat.
  const searchResults = useMemo(() => {
    const q = normalize(query.trim());
    if (q.length < 2) return [];
    if (remote && account) {
      // Un compte réel n'est pas indexé localement : la recherche est faite
      // par Google, sur l'ensemble du compte.
      return (remoteSearchState?.nodes ?? [])
        .filter((node) => {
          if (typeFilter === 'all') return true;
          if (typeFilter === 'folder') return Boolean(node.children);
          return node.type === typeFilter;
        })
        .map((node) => ({
          node,
          path: [node.name],
          depth: 0,
          accountId: account.id,
        }));
    }
    return catalog.entries
      .filter((entry) => normalize(entry.node.name).includes(q))
      .filter((entry) => {
        if (typeFilter === 'all') return true;
        if (typeFilter === 'folder') return Boolean(entry.node.children);
        return entry.node.type === typeFilter;
      })
      .sort(
        (a, b) =>
          a.path.length - b.path.length ||
          a.node.name.localeCompare(b.node.name, 'fr', { numeric: true }),
      )
      // Un même fichier existe sur plusieurs comptes : on met en avant la
      // première occurrence et on évite les répétitions exactes de chemin.
      .filter((entry, index, list) => {
        const signature = `${entry.node.name}|${entry.path.join('/')}`;
        return (
          list.findIndex(
            (other) => `${other.node.name}|${other.path.join('/')}` === signature,
          ) === index
        );
      })
      .slice(0, 80)
      .map((entry) => ({
        node: entry.node,
        path: entry.path,
        depth: entry.path.length - 1,
        accountId: entry.accountId,
      }));
  }, [catalog.entries, query, typeFilter, remote, account, remoteSearchState]);

  // En vue partagée, la saisie filtre la liste affichée plutôt que d'interroger
  // tout le compte : on ne montre pas des résultats qui ne sont pas partagés.
  const searchMode = !sharedView && normalize(query.trim()).length >= 2;
  const rows: {
    node: FileNode;
    path: string[];
    depth: number;
    accountId: string;
  }[] = searchMode
    ? searchResults
    : children.map((node) => ({
        node,
        path: [...path, remote && node.children ? `${node.name}${ID_SEPARATOR}${node.id}` : node.name],
        depth: path.length,
        accountId: state.explorer.accountId,
      }));

  const visible = useMemo(() => {
    const q = normalize(query.trim());
    const filtered = children.filter((node) => {
      if (q && !normalize(node.name).includes(q)) return false;
      if (typeFilter === 'all') return true;
      if (typeFilter === 'folder') return Boolean(node.children);
      return node.type === typeFilter;
    });

    const direction = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // Dossiers d'abord pour le tri par nom/type ; pour la taille et la date,
      // c'est la valeur réelle qui décide.
      if (sort.key === 'name' || sort.key === 'type' || sort.key === 'date') {
        const aFolder = a.children ? 0 : 1;
        const bFolder = b.children ? 0 : 1;
        if (aFolder !== bFolder) return aFolder - bFolder;
      }
      switch (sort.key) {
        case 'size':
          return (a.size - b.size) * direction;
        case 'date':
          return (
            (new Date(a.modified).getTime() - new Date(b.modified).getTime()) * direction
          );
        case 'type':
          return a.type.localeCompare(b.type) * direction;
        default:
          return (
            a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' }) *
            direction
          );
      }
    });
  }, [children, query, sort, typeFilter]);

  // Garde le compte actif visible dans la colonne de gauche.
  useEffect(() => {
    const active = railRef.current?.querySelector<HTMLElement>('.rail-account.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [state.explorer.accountId]);

  // Réinitialise la sélection à chaque changement de dossier.
  const pathSignature = `${account?.id ?? ''}:${path.join('/')}`;
  useEffect(() => {
    setSelected(new Set());
    setFocusedId(null);
    setQuery('');
    setTypeFilter('all');
  }, [pathSignature]);

  // Échap quitte la recherche, sinon vide la sélection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.key === 'Escape') {
        if (selected.size) setSelected(new Set());
        else if (query) setQuery('');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        setSelected(new Set(rows.map((row) => row.node.id)));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected.size, query, rows]);

  if (!account) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="page-head__text">
            <div className="page-eyebrow">Explorateur</div>
            <h1 className="page-title">Tous les fichiers</h1>
          </div>
        </div>
        <div className="panel empty-panel">
        <div className="empty">
          <span className="empty__icon">
            <Folder size={18} />
          </span>
          <p className="empty__title">
            {state.accounts.length === 0
              ? 'Aucun compte connecté'
              : 'Aucun compte sélectionné'}
          </p>
          <p className="empty__text">
            {state.accounts.length === 0
              ? 'Connectez votre compte Google pour parcourir vos fichiers. L’application lit uniquement ce que vous autorisez : rien n’est copié, déplacé ni supprimé.'
              : 'Choisissez un compte dans la liste de gauche pour afficher son contenu.'}
          </p>
          <div className="empty__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() =>
                dispatch({ type: 'route', route: { name: 'clouds', provider: 'gdrive' } })
              }
            >
              {state.accounts.length === 0 ? 'Connecter Google Drive' : 'Ouvrir les clouds'}
            </button>
          </div>
        </div>
        </div>
      </div>
    );
  }

  const provider = PROVIDERS[account.provider];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.node.id));
  const someSelected = selected.size > 0 && !allSelected;

  const selectedNodes = rows.map((row) => row.node).filter((node) => selected.has(node.id));
  const selectedSize = selectedNodes.reduce((sum, node) => sum + node.size, 0);
  const fileCount = children.filter((node) => !node.children).length;
  const folderCount = children.length - fileCount;

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openNode = (node: FileNode) => {
    if (node.children) {
      // Un dossier réel conserve son identifiant Drive dans le segment de chemin.
      dispatch({
        type: 'explorer/enter',
        name: remote ? `${node.name}${ID_SEPARATOR}${node.id}` : node.name,
      });
      return;
    }
    setFocusedId(node.id);
  };

  /**
   * File d'un dossier complet préparé par le processus principal.
   *
   * Chaque fichier du plan devient une ligne de la file, avec son chemin
   * relatif : c'est ce que le processus principal utilise pour recréer
   * l'arborescence sur le disque. Le nom affiché garde la forme du chemin pour
   * qu'une file de 200 fichiers reste lisible.
   */
  /**
   * Lance des transferts côté processus principal.
   *
   * Un refus du processus principal doit apparaître **dans la file** : sans ce
   * traitement, la ligne restait « En cours » à 0 % alors que rien n'était
   * téléchargé, et seul un message fugace l'annonçait.
   */
  const launchDownloads = (requests: GoogleDownloadRequest[]) => {
    const bridge = getBridge();
    if (!bridge) return;
    for (const request of requests) {
      void bridge.google.download(request).catch((cause: Error) => {
        dispatch({
          type: 'downloads/progress',
          updates: [
            {
              id: request.id,
              status: 'error',
              received: 0,
              size: request.size,
              speed: 0,
              message: cause?.message || 'Téléchargement impossible',
            },
          ],
        });
        toast.push(cause?.message || 'Téléchargement impossible', 'error');
      });
    }
  };

  const queuePlan = (
    plan: GoogleFolderPlan,
    folderName: string,
    basePath: string[],
    source: Account,
  ) => {
    const real = isRealAccount(source);
    const googleId = real ? realAccountId(source) : undefined;
    const bridge = getBridge();
    if (!bridge || !googleId) {
      toast.push('Téléchargement indisponible dans le navigateur — utilisez la version Windows', 'warn');
      return;
    }
    const stamp = Date.now();
    // Un dossier entier conserve son arborescence, sous le nom du cloud.
    const root = state.settings.organizeDownloads ? cloudFolder(source.provider) : '';
    const items = plan.files.map((file, index) => {
      const name = file.path.split('/').pop() ?? file.path;
      const subPath = [root, folderName, ...file.path.split('/').slice(0, -1)]
        .filter(Boolean)
        .join('/');
      return createDownload({
        id: `${file.fileId}-${stamp}-${index}`,
        name: file.path,
        type: detectType(name),
        size: file.size,
        provider: source.provider,
        accountId: source.id,
        accountName: source.name,
        path: [...basePath, folderName, ...file.path.split('/')],
        seed: name.length * 7 + file.size,
        remoteId: file.fileId,
        remoteAccount: googleId,
        ...(subPath ? { subPath } : {}),
      });
    });

    // La file est créée avant l'appel au pont : sinon un refus immédiat
    // arriverait avant la ligne et laisserait un transfert « En cours » à 0 %
    // qui n'avance jamais.
    dispatch({ type: 'downloads/add', items });
    launchDownloads(
      items.map((item, index) => ({
        id: item.id,
        accountId: googleId,
        fileId: plan.files[index].fileId,
        name: item.name.split('/').pop() ?? item.name,
        size: plan.files[index].size,
        dir: state.settings.downloadFolder,
        // Le dossier choisi devient la racine du lot sur le disque.
        ...(items[index].subPath ? { subPath: items[index].subPath } : {}),
      })),
    );
    const total = plan.totalBytes;
    toast.push(
      `${folderName} · ${plural(items.length, 'fichier')} (${formatBytes(total)}) en file`,
      'ok',
    );
    if (plan.skipped.length) {
      toast.push(
        `${plural(plan.skipped.length, 'document')} Google natif écarté${plan.skipped.length > 1 ? 's' : ''}`,
        'warn',
      );
    }
  };

  const queueDownloads = (
    nodes: FileNode[],
    basePath: string[] = path,
    source: Account = account,
  ) => {
    const downloadable = nodes.filter((node) => !node.children);
    if (!downloadable.length) {
      toast.push('Les dossiers doivent être ouverts avant d’être téléchargés', 'warn');
      return;
    }
    const real = isRealAccount(source);
    const googleId = real ? realAccountId(source) : undefined;
    const items = downloadable.map((node) => {
      // Rangement `…\Google Drive\Vidéos` : le type du fichier décide du
      // sous-dossier, le cloud du premier niveau.
      const subPath = downloadSubPath(
        source.provider,
        node.type,
        state.settings.organizeDownloads,
      );
      return createDownload({
        id: `${node.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: node.name,
        type: node.type,
        size: node.size,
        provider: source.provider,
        accountId: source.id,
        accountName: source.name,
        path: [...basePath, node.name],
        seed: node.name.length * 7 + node.size,
        ...(real && googleId ? { remoteId: node.id, remoteAccount: googleId } : {}),
        ...(subPath ? { subPath } : {}),
      });
    });

    // Le transfert est confié au processus principal, qui écrit réellement sur
    // le disque et renvoie la progression. Sans « pont » (aperçu navigateur),
    // la file reste vide : on ne simule plus de téléchargement.
    if (!getBridge()) {
      toast.push('Téléchargement indisponible dans le navigateur — utilisez la version Windows', 'warn');
      return;
    }

    dispatch({ type: 'downloads/add', items });
    if (items.length && items[0].remoteId && googleId) {
      const sizes = new Map(downloadable.map((node) => [node.id, node.size]));
      launchDownloads(
        items.map((item) => ({
          id: item.id,
          accountId: googleId,
          fileId: item.remoteId as string,
          name: item.name,
          size: sizes.get(item.remoteId as string) ?? 0,
          dir: state.settings.downloadFolder,
          ...(item.subPath ? { subPath: item.subPath } : {}),
        })),
      );
    }
    toast.push(`${plural(items.length, 'téléchargement')} démarré${items.length > 1 ? 's' : ''}`, 'ok');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Explorateur</div>
          <h1 className="page-title">Tous les fichiers</h1>
          <p className="page-subtitle">
            Parcourez les arborescences de vos comptes. Sélection simple ou multiple
            (Ctrl / Maj), recherche et tri instantanés.
          </p>
        </div>
        <div className="page-head__actions">
          <span className="badge">
            <HardDrive size={11} />
            {formatDecimal(state.accounts.length)} comptes
          </span>
        </div>
      </div>

      <div className="explorer">
        <div className="explorer__rail" ref={railRef}>
          <div className="rail-label">
            <span>Comptes</span>
            {state.accounts.length > 5 ? (
              <span className="rail-label__count tnum">{state.accounts.length}</span>
            ) : null}
          </div>
          {state.accounts.length > 5 ? (
            <div className="rail-search">
              <Search size={12} />
              <input
                className="rail-search__input"
                placeholder="Filtrer les comptes…"
                value={railQuery}
                onChange={(event) => setRailQuery(event.target.value)}
                aria-label="Filtrer les comptes du volet"
              />
              {railQuery ? (
                <button
                  type="button"
                  className="rail-search__clear"
                  onClick={() => setRailQuery('')}
                  aria-label="Effacer le filtre des comptes"
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
          ) : null}
          {PROVIDER_LIST.map((item) => {
            const accs = state.accounts
              .filter((a) => a.provider === item.id)
              .filter((acc) => !railMatches || railMatches.has(acc.id));
            if (!accs.length) return null;
            return (
              <div key={item.id}>
                <div className="rail-group">
                  <ProviderDot brand={item.brand} />
                  {item.name}
                </div>
                {accs.map((acc) => (
                  <button
                    key={acc.id}
                    type="button"
                    className={`rail-account${
                      acc.id === account.id ? ' is-active' : ''
                    }`}
                    style={{ ['--brand' as string]: item.brand }}
                    onClick={() => {
                      if (acc.id !== account.id) {
                        dispatch({ type: 'explorer/chooseAccount', accountId: acc.id });
                      } else {
                        dispatch({ type: 'explorer/root' });
                      }
                    }}
                    title={acc.email}
                  >
                    <span
                      className="rail-mark"
                      style={{ ['--mark' as string]: accountMark(acc.email) }}
                    />
                    <span className="rail-account__name">{shortAddress(acc.email)}</span>
                    {isRealAccount(acc) ? (
                      <span className="rail-account__live" title="Compte Google réel" />
                    ) : null}
                  </button>
                ))}
                {accs
                  .filter((acc) => isRealAccount(acc) && acc.id === account.id)
                  .map((acc) => (
                    <button
                      key={`${acc.id}-shared`}
                      type="button"
                      className={`rail-account rail-account--sub${
                        sharedView ? ' is-active' : ''
                      }`}
                      style={{ ['--brand' as string]: item.brand }}
                      onClick={() =>
                        dispatch({
                          type: 'explorer/view',
                          view: sharedView ? 'files' : 'shared',
                          accountId: acc.id,
                        })
                      }
                      title={
                        sharedView
                          ? 'Revenir aux dossiers du compte'
                          : 'Fichiers que d’autres personnes ont partagés avec ce compte'
                      }
                    >
                      <Users size={12} strokeWidth={1.9} />
                      <span className="rail-account__name">Partagés avec moi</span>
                    </button>
                  ))}
              </div>
            );
          })}
          {railMatches && railMatches.size === 0 ? (
            <p className="rail-empty">
              Aucun compte ne correspond à « {railQuery.trim()} ».
            </p>
          ) : null}
          <div className="rail-foot">
            <div className="rail-foot__label">
              Occupation
              <span className="rail-foot__value">
                {Math.round((account.usedBytes / Math.max(account.quotaBytes, 1)) * 100)} %
              </span>
            </div>
            <Meter value={account.usedBytes / Math.max(account.quotaBytes, 1)} tone={provider.brand} />
            <div
              style={{
                marginTop: 6,
                fontSize: 10,
                color: 'var(--text-4)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatBytes(account.usedBytes)} sur {formatBytes(account.quotaBytes)}
            </div>
          </div>
        </div>

        <div className="explorer__body">
          <div className="explorer__toolbar">
            <button
              type="button"
              className="icon-btn icon-btn--bordered"
              onClick={() => dispatch({ type: 'explorer/back' })}
              disabled={state.explorer.history.length === 0}
              title="Dossier précédent"
              aria-label="Dossier précédent"
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              className="icon-btn icon-btn--bordered"
              onClick={() =>
                sharedView
                  ? dispatch({ type: 'explorer/view', view: 'files', accountId: account.id })
                  : dispatch({ type: 'explorer/root' })
              }
              disabled={!sharedView && path.length === 0}
              title={sharedView ? 'Revenir aux dossiers' : 'Racine du compte'}
              aria-label={sharedView ? 'Revenir aux dossiers' : 'Racine du compte'}
            >
              <HomeIcon size={14} />
            </button>

            {sharedView ? (
              <nav className="crumbs" aria-label="Fil d’Ariane">
                <button
                  type="button"
                  className="crumb crumb--root"
                  title={account.name}
                  onClick={() =>
                    dispatch({ type: 'explorer/view', view: 'files', accountId: account.id })
                  }
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 99,
                      background: provider.brand,
                      flex: 'none',
                    }}
                  />
                  <span className="crumb__label">{account.name}</span>
                </button>
                <span className="crumb-seg">
                  <span className="crumb-sep">
                    <ChevronRight size={12} />
                  </span>
                  <span className="crumb crumb--inline">
                    <Users size={12} strokeWidth={1.9} />
                    Partagés avec moi
                  </span>
                </span>
              </nav>
            ) : (
              <Breadcrumbs
                accountName={account.name}
                brand={provider.brand}
                path={cleanPath}
                onRoot={() => dispatch({ type: 'explorer/root' })}
                onNavigate={(target) =>
                  dispatch({ type: 'explorer/open', accountId: account.id, path: target })
                }
              />
            )}

          </div>

          <div className="explorer__filters">
            <div className="search">
              <Search size={13} />
              <input
                ref={searchRef}
                className="input"
                placeholder={
                  sharedView
                    ? 'Filtrer les fichiers partagés…'
                    : remote
                      ? 'Rechercher dans ce compte Google…'
                      : 'Rechercher dans tous les comptes…'
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Rechercher dans ce dossier"
              />
              {query ? (
                <button
                  type="button"
                  className="search__clear"
                  onClick={() => setQuery('')}
                  aria-label="Effacer le filtre"
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
            <div className="segmented" role="group" aria-label="Filtrer par catégorie">
              {TYPE_FILTERS.filter(
                (filter) =>
                  filter.id === 'all' ||
                  countForType(children, filter.id) > 0,
              ).map((filter) => (
                <button
                  key={filter.id}
                  type="button"
                  className={`segmented__item${typeFilter === filter.id ? ' is-active' : ''}`}
                  onClick={() => setTypeFilter(filter.id)}
                >
                  {filter.label}
                  <span className="segmented__count tnum">
                    {countForType(children, filter.id)}
                  </span>
                </button>
              ))}
            </div>
            <div className="filter-bar__spacer" />
            <SortMenu sort={sort} onChange={setSort} />
          </div>

          <div className={`selection-bar${selected.size > 0 ? ' is-active' : ''}`}>
            {selected.size === 0 ? (
              <>
                <span className="selection-bar__path">
                  {searchMode ? <Search size={12} /> : sharedView ? <Users size={12} /> : <Folder size={12} />}
                  {searchMode
                    ? remote
                      ? `${provider.name} · ${account.name}`
                      : 'Tous les comptes'
                    : sharedView
                      ? 'Partagés avec moi'
                      : plural(fileCount, 'fichier')}
                </span>
                <span className="selection-bar__size">
                  {searchMode
                    ? `${formatDecimal(searchResults.length)} résultat${
                        searchResults.length > 1 ? 's' : ''
                      } · ${remote ? 'ce compte' : 'tous les comptes'}`
                    : [
                        folderCount > 0 ? plural(folderCount, 'dossier') : null,
                        formatBytes(children.reduce((sum, node) => sum + node.size, 0)),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                </span>
                <div className="selection-bar__actions">
                  {remote && !sharedView && !searchMode ? (
                    <button
                      type="button"
                      className="btn btn--sm"
                      title="Ouvrir ce dossier dans Google Drive, pour y déposer des fichiers"
                      onClick={() => {
                        void getBridge()?.google.openExternal?.(
                          driveFolderUrl(driveFolderId(path)),
                        );
                      }}
                    >
                      <ExternalLink size={12} />
                      Ouvrir dans Drive
                    </button>
                  ) : null}
                  <span className="selection-bar__hint">
                    <MousePointerClick size={11} />
                    Double-clic pour ouvrir
                  </span>
                </div>
              </>
            ) : (
              <>
              <span className="selection-bar__count">
                {plural(selected.size, 'élément')}
              </span>
              <span className="selection-bar__size">· {formatBytes(selectedSize)}</span>
              <div className="selection-bar__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    const first = selectedNodes.find((node) => !node.children);
                    if (!first) {
                      toast.push('Aucun fichier à ajouter aux favoris', 'warn');
                      return;
                    }
                    const targets = rows.filter(
                      (row) => selected.has(row.node.id) && !row.node.children,
                    );
                    const already =
                      targets.length > 0 &&
                      targets.every((row) =>
                        favoriteSet.has(catalogKey(account.id, row.path)),
                      );
                    targets.forEach((row) =>
                      dispatch({
                        type: 'favorite/toggle',
                        accountId: row.accountId,
                        path: row.path,
                      }),
                    );
                    toast.push(
                      already ? 'Favoris retirés' : 'Ajouté aux favoris',
                      already ? 'default' : 'ok',
                    );
                    setSelected(new Set());
                  }}
                >
                  <Star size={12} />
                  Favoris
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => {
                    const picked = rows.filter((row) => selected.has(row.node.id));
                    if (!picked.length) {
                      toast.push('Sélectionnez au moins un élément à télécharger', 'warn');
                      return;
                    }
                    // Un dossier réel ne se télécharge pas fichier par fichier :
                    // on prépare l'arborescence côté processus principal.
                    const folderRow = picked.find(
                      (row) =>
                        row.node.children && isRealAccount(
                          state.accounts.find((a) => a.id === row.accountId) ?? account,
                        ),
                    );
                    if (folderRow) {
                      const targetAccount =
                        state.accounts.find((a) => a.id === folderRow.accountId) ?? account;
                      const googleId = realAccountId(targetAccount);
                      if (!googleId) return;
                      setFolderTarget({
                        name: folderRow.node.name,
                        fileId: folderRow.node.id,
                        accountId: googleId,
                        basePath: folderRow.path.slice(0, -1),
                      });
                      setSelected(new Set());
                      return;
                    }
                    const grouped = picked.filter((row) => !row.node.children);
                    if (!grouped.length) {
                      toast.push('Aucun fichier à télécharger dans cette sélection', 'warn');
                      return;
                    }
                    grouped.forEach((row) =>
                      queueDownloads(
                        [row.node],
                        row.path.slice(0, -1),
                        state.accounts.find((a) => a.id === row.accountId) ?? account,
                      ),
                    );
                    setSelected(new Set());
                  }}
                >
                  <Download size={12} />
                  Télécharger
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setSelected(new Set())}
                  title="Annuler la sélection"
                  aria-label="Annuler la sélection"
                >
                  <X size={13} />
                </button>
              </div>
              </>
            )}
          </div>

          <div className="filetable-wrap">
            {remote && searchMode && remoteSearchState?.status === 'loading' ? (
              <div className="filetable-loading">
                <RefreshCw size={13} className="spin" />
                Recherche dans Google Drive…
              </div>
            ) : remote && activeState?.status === 'loading' && rows.length === 0 ? (
              <div className="filetable-loading">
                <RefreshCw size={13} className="spin" />
                {sharedView
                  ? 'Recherche des fichiers partagés…'
                  : 'Chargement du dossier depuis Google Drive…'}
              </div>
            ) : remote && activeState?.status === 'error' && rows.length === 0 ? (
              <div className="filetable-error">
                <CloudOff size={20} />
                <p className="filetable-error__title">
                  {sharedView ? 'Fichiers partagés injoignables' : 'Google Drive est injoignable'}
                </p>
                <p className="filetable-error__text">{activeState.error}</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    if (sharedView) reloadRemote(remoteId);
                    else reloadRemote(remoteId, path);
                  }}
                >
                  <RotateCcw size={12} />
                  Réessayer
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="filetable-empty">
                {searchMode ? (
                  <SearchX size={20} />
                ) : sharedView ? (
                  <Users size={20} />
                ) : (
                  <ListFilter size={20} />
                )}
                <p className="filetable-empty__title">
                  {searchMode
                    ? 'Aucun fichier ne correspond'
                    : sharedView
                      ? query
                        ? 'Aucun fichier partagé ne correspond'
                        : 'Aucun fichier partagé'
                      : query
                        ? 'Aucun résultat dans ce dossier'
                        : 'Dossier vide'}
                </p>
                <p className="filetable-empty__text">
                  {searchMode
                    ? remote
                      ? 'La recherche interroge tout ce compte Google. Essayez un autre terme.'
                      : 'La recherche couvre tous les comptes. Essayez un autre terme.'
                    : sharedView
                      ? query
                        ? 'Le filtre porte uniquement sur les fichiers partagés. Effacez-le pour revoir la liste complète.'
                        : 'Personne ne vous a partagé de fichier pour l’instant. Les éléments partagés par d’autres apparaîtront ici, sans que vous ayez à les ajouter à votre Drive.'
                      : query
                        ? 'Saisissez au moins deux caractères pour chercher dans tout le compte.'
                        : remote
                          ? 'Ce dossier Google Drive est vide.'
                          : 'Ce dossier ne contient aucun élément.'}
                </p>
                {query ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    style={{ marginTop: 6 }}
                    onClick={() => setQuery('')}
                  >
                    <RotateCcw size={12} />
                    Effacer le filtre
                  </button>
                ) : sharedView ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    style={{ marginTop: 6 }}
                    onClick={() => reloadRemote(remoteId)}
                  >
                    <RefreshCw size={12} />
                    Actualiser
                  </button>
                ) : null}
              </div>
            ) : (
              <table className="filetable">
                <thead>
                  <tr>
                    <th className="col-check">
                      <Checkbox
                        checked={allSelected}
                        mixed={someSelected}
                        onChange={() =>
                          setSelected(
                            allSelected ? new Set() : new Set(rows.map((row) => row.node.id)),
                          )
                        }
                        label="Tout sélectionner"
                      />
                    </th>
                    <th
                      className={`is-sortable${sort.key === 'name' ? ' is-sorted' : ''}`}
                      onClick={() =>
                        setSort({
                          key: 'name',
                          dir: sort.key === 'name' && sort.dir === 'asc' ? 'desc' : 'asc',
                        })
                      }
                    >
                      <span className="th-inner">
                        Nom
                        {sort.key === 'name' ? (
                          sort.dir === 'asc' ? (
                            <ChevronUp size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )
                        ) : null}
                      </span>
                    </th>
                    <th
                      className={`col-type is-sortable${sort.key === 'type' ? ' is-sorted' : ''}`}
                      onClick={() =>
                        setSort({ key: 'type', dir: sort.dir === 'asc' ? 'desc' : 'asc' })
                      }
                    >
                      <span className="th-inner">
                        Type
                        {sort.key === 'type' ? (
                          sort.dir === 'asc' ? (
                            <ChevronUp size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )
                        ) : null}
                      </span>
                    </th>
                    <th
                      className={`col-size is-sortable${sort.key === 'size' ? ' is-sorted' : ''}`}
                      onClick={() =>
                        setSort({ key: 'size', dir: sort.dir === 'asc' ? 'desc' : 'asc' })
                      }
                    >
                      <span className="th-inner">
                        Taille
                        {sort.key === 'size' ? (
                          sort.dir === 'asc' ? (
                            <ChevronUp size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )
                        ) : null}
                      </span>
                    </th>
                    <th
                      className={`col-date is-sortable${sort.key === 'date' ? ' is-sorted' : ''}`}
                      onClick={() =>
                        setSort({ key: 'date', dir: sort.dir === 'asc' ? 'desc' : 'asc' })
                      }
                    >
                      <span className="th-inner">
                        Date
                        {sort.key === 'date' ? (
                          sort.dir === 'asc' ? (
                            <ChevronUp size={11} />
                          ) : (
                            <ChevronDown size={11} />
                          )
                        ) : null}
                      </span>
                    </th>
                    <th className="col-star" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ node, path: rowPath, depth, accountId: rowAccountId }) => {
                    const isSelected = selected.has(node.id);
                    const nodePath = rowPath;
                    const rowAccount =
                      state.accounts.find((a) => a.id === rowAccountId) ?? account;
                    const isFavorite = favoriteSet.has(catalogKey(rowAccountId, nodePath));
                    return (
                      <tr
                        key={node.id}
                        className={[
                          isSelected ? 'is-selected' : '',
                          focusedId === node.id ? 'is-focused' : '',
                          node.children ? 'is-folder' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        onClick={(event) => {
                          // En recherche globale, sélectionner un résultat d'un
                          // autre compte bascule l'explorateur sur ce compte.
                          if (rowAccountId !== state.explorer.accountId) {
                            dispatch({
                              type: 'explorer/open',
                              accountId: rowAccountId,
                              path: searchMode
                                ? rowPath.slice(0, -1)
                                : state.explorer.path,
                            });
                          }
                          setFocusedId(node.id);
                          if (event.ctrlKey || event.metaKey) {
                            toggleSelect(node.id);
                          } else {
                            setSelected(new Set([node.id]));
                          }
                        }}
                        onDoubleClick={() => {
                          if (node.children) {
                            dispatch({
                              type: 'explorer/open',
                              accountId: rowAccountId,
                              path: rowPath,
                            });
                            return;
                          }
                          openNode(node);
                        }}
                      >
                        <td className="col-check" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            mixed={false}
                            onChange={() => {
                              setFocusedId(node.id);
                              toggleSelect(node.id);
                            }}
                            label={`Sélectionner ${node.name}`}
                          />
                        </td>
                        <td>
                          <span className="cell-name">
                            <TypeIcon type={node.type} size={13} />
                            <span className="cell-name__body">
                              <span className="cell-name__text">{node.name}</span>
                              {searchMode ? (
                                <span className="cell-name__path">
                                  {PROVIDERS[rowAccount.provider].name} ·{' '}
                                  {rowAccount.name}
                                  {depth > 0 ? ` / ${rowPath.slice(0, -1).join(' / ')}` : ''}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </td>
                        <td className="col-type">
                          <span className="truncate" title={labelFor(node)}>
                            {node.children ? 'Dossier' : labelFor(node)}
                          </span>
                        </td>
                        <td className="col-size">
                          <span className="truncate">
                            {node.children
                              ? node.children.length
                                ? `${node.children.length} él.`
                                : 'Dossier'
                              : node.size
                                ? formatBytes(node.size)
                                : '—'}
                          </span>
                        </td>
                        <td className="col-date">
                          <span className="truncate" title={formatDate(node.modified)}>
                            {formatRelative(node.modified)}
                          </span>
                        </td>
                        <td className="col-star" onClick={(event) => event.stopPropagation()}>
                          <div className="file-actions">
                            {!node.children ? (
                              <button
                                type="button"
                                className={`star-btn${isFavorite ? ' is-on' : ''}`}
                                title={isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
                                aria-label={
                                  isFavorite ? 'Retirer des favoris' : 'Ajouter aux favoris'
                                }
                                onClick={() => {
                                  dispatch({
                                    type: 'favorite/toggle',
                                    accountId: rowAccountId,
                                    path: nodePath,
                                  });
                                  toast.push(
                                    isFavorite ? 'Retiré des favoris' : 'Ajouté aux favoris',
                                    isFavorite ? 'default' : 'ok',
                                  );
                                }}
                              >
                                <Star
                                  size={13}
                                  fill={isFavorite ? 'currentColor' : 'none'}
                                />
                              </button>
                            ) : null}
                            {node.children ? (
                              <>
                                <button
                                  type="button"
                                  className="icon-btn"
                                  title="Ouvrir le dossier"
                                  aria-label={`Ouvrir ${node.name}`}
                                  onClick={() =>
                                    dispatch({
                                      type: 'explorer/open',
                                      accountId: rowAccountId,
                                      path: rowPath,
                                    })
                                  }
                                >
                                  <FolderOpen size={13} />
                                </button>
                                {isRealAccount(
                                  state.accounts.find((a) => a.id === rowAccountId) ?? account,
                                ) ? (
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    title="Télécharger le dossier entier"
                                    aria-label={`Télécharger le dossier ${node.name}`}
                                    onClick={() => {
                                      const targetAccount =
                                        state.accounts.find((a) => a.id === rowAccountId) ??
                                        account;
                                      const googleId = realAccountId(targetAccount);
                                      if (!googleId) return;
                                      setFolderTarget({
                                        name: node.name,
                                        fileId: node.id,
                                        accountId: googleId,
                                        basePath: rowPath.slice(0, -1),
                                      });
                                    }}
                                  >
                                    <FolderDown size={13} />
                                  </button>
                                ) : null}
                              </>
                            ) : (
                              <button
                                type="button"
                                className="icon-btn"
                                title="Télécharger ce fichier"
                                aria-label={`Télécharger ${node.name}`}
                                onClick={() =>
                                  queueDownloads([node], rowPath.slice(0, -1), rowAccount)
                                }
                              >
                                <Download size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div className="filetable-foot">
            <span>
              {searchMode
                ? `${formatDecimal(rows.length)} résultat${rows.length > 1 ? 's' : ''} · ${plural(
                    new Set(rows.map((row) => row.accountId)).size,
                    'compte',
                  )}`
                : typeFilter !== 'all'
                  ? `${formatDecimal(visible.length)} sur ${formatDecimal(children.length)} affiché${
                      visible.length > 1 ? 's' : ''
                    }`
                  : plural(children.length, 'élément')}
            </span>
            {selected.size > 0 ? (
              <span>· {plural(selected.size, 'sélectionné', 'sélectionnés')}</span>
            ) : null}
            <span className="filetable-foot__spacer" />
            <span title={provider.name} style={{ color: 'var(--text-3)' }}>
              {account.name}
            </span>
            <span className="filetable-foot__sep">/</span>
            <span className="filetable-foot__path">
              {searchMode
                ? remote
                  ? 'Recherche Google'
                  : 'Recherche globale'
                : cleanPath.length
                  ? cleanPath.join(' / ')
                  : 'Racine'}
            </span>
          </div>
        </div>
      </div>

      {folderTarget ? (
        <FolderDownloadDialog
          folderName={folderTarget.name}
          accountId={folderTarget.accountId}
          fileId={folderTarget.fileId}
          basePath={folderTarget.basePath}
          targetDir={state.settings.downloadFolder}
          onClose={() => setFolderTarget(null)}
          onQueue={(plan, folderName, basePath) => queuePlan(plan, folderName, basePath, account)}
        />
      ) : null}
    </div>
  );
}
