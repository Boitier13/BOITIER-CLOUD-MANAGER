import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  CloudOff,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Download,
  Folder,
  FolderOpen,
  HardDrive,
  Home as HomeIcon,
  ListFilter,
  MousePointerClick,
  RotateCcw,
  Search,
  SearchX,
  Star,
  X,
} from 'lucide-react';
import {
  PROVIDERS,
  PROVIDER_LIST,
  type Account,
  type FileNode,
} from '../data/catalog';
import { catalogKey, useCatalog, useStore } from '../store';
import { isRealAccount, realAccountId } from '../lib/google';
import {
  displaySegment,
  ID_SEPARATOR,
  useReloadRemote,
  useRemoteFolder,
  useRemoteSearch,
} from '../lib/remote';
import { getBridge } from '../lib/bridge';
import {
  formatBytes,
  formatDate,
  formatDecimal,
  formatRelative,
  normalize,
  plural,
} from '../lib/format';
import { getChildren } from '../lib/tree';
import { Meter, TypeIcon } from '../components/visuals';
import { createDownload } from '../lib/downloads';
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
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'name',
    dir: 'asc',
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  const remoteFolder = useRemoteFolder(account?.id ?? null, path, remote);

  // Arrivée sur l'écran sans compte sélectionné (première connexion, compte
  // retiré) : on ouvre le premier compte disponible au lieu de laisser une
  // invite alors qu'un compte existe.
  useEffect(() => {
    if (account || state.accounts.length === 0) return;
    dispatch({ type: 'explorer/chooseAccount', accountId: state.accounts[0].id });
  }, [account, state.accounts, dispatch]);
  const remoteQuery = query.trim().length >= 2 ? query : '';
  const remoteSearchState = useRemoteSearch(account?.id ?? null, remoteQuery, remote);
  const reloadRemote = useReloadRemote();

  const children = useMemo(() => {
    if (!account) return [];
    if (isRealAccount(account)) return remoteFolder?.nodes ?? [];
    return getChildren(catalog.trees[account.id] ?? [], path) ?? [];
  }, [catalog.trees, account, path, remoteFolder]);

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

  const searchMode = normalize(query.trim()).length >= 2;
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
    const items = downloadable.map((node) =>
      createDownload({
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
      }),
    );

    // Le transfert est confié au processus principal, qui écrit réellement sur
    // le disque et renvoie la progression. Sans « pont » (aperçu navigateur),
    // la file reste vide : on ne simule plus de téléchargement.
    if (!getBridge()) {
      toast.push('Téléchargement indisponible dans le navigateur — utilisez la version Windows', 'warn');
      return;
    }

    if (items.length && items[0].remoteId && googleId) {
      const bridge = getBridge();
      const sizes = new Map(downloadable.map((node) => [node.id, node.size]));
      void Promise.all(
        items.map((item) =>
          bridge?.google
            .download({
              id: item.id,
              accountId: googleId,
              fileId: item.remoteId as string,
              name: item.name,
              size: sizes.get(item.remoteId as string) ?? 0,
              dir: state.settings.downloadFolder,
            })
            .catch((cause: Error) =>
              toast.push(cause.message || 'Téléchargement impossible', 'error'),
            ),
        ),
      );
    }
    dispatch({ type: 'downloads/add', items });
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
          <div className="rail-label">Comptes</div>
          {PROVIDER_LIST.map((item) => {
            const accs = state.accounts.filter((a) => a.provider === item.id);
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
                    <span className="rail-account__dot" />
                    <span className="rail-account__name">{acc.name}</span>
                    {isRealAccount(acc) ? (
                      <span className="rail-account__live" title="Compte Google réel" />
                    ) : null}
                  </button>
                ))}
              </div>
            );
          })}
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
              onClick={() => dispatch({ type: 'explorer/root' })}
              disabled={path.length === 0}
              title="Racine du compte"
              aria-label="Racine du compte"
            >
              <HomeIcon size={14} />
            </button>

            <Breadcrumbs
              accountName={account.name}
              brand={provider.brand}
              path={cleanPath}
              onRoot={() => dispatch({ type: 'explorer/root' })}
              onNavigate={(target) =>
                dispatch({ type: 'explorer/open', accountId: account.id, path: target })
              }
            />

          </div>

          <div className="explorer__filters">
            <div className="search">
              <Search size={13} />
              <input
                ref={searchRef}
                className="input"
                placeholder={
                  remote ? 'Rechercher dans ce compte Google…' : 'Rechercher dans tous les comptes…'
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
                  {searchMode ? <Search size={12} /> : <Folder size={12} />}
                  {searchMode
                    ? remote
                      ? `${provider.name} · ${account.name}`
                      : 'Tous les comptes'
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
                    const grouped = rows.filter(
                      (row) => selected.has(row.node.id) && !row.node.children,
                    );
                    if (!grouped.length) {
                      toast.push('Les dossiers doivent être ouverts avant d’être téléchargés', 'warn');
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
            ) : remote && remoteFolder?.status === 'loading' && rows.length === 0 ? (
              <div className="filetable-loading">
                <RefreshCw size={13} className="spin" />
                Chargement du dossier depuis Google Drive…
              </div>
            ) : remote && remoteFolder?.status === 'error' && rows.length === 0 ? (
              <div className="filetable-error">
                <CloudOff size={20} />
                <p className="filetable-error__title">Google Drive est injoignable</p>
                <p className="filetable-error__text">{remoteFolder.error}</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    reloadRemote(account.id, path);
                  }}
                >
                  <RotateCcw size={12} />
                  Réessayer
                </button>
              </div>
            ) : rows.length === 0 ? (
              <div className="filetable-empty">
                {searchMode ? <SearchX size={20} /> : <ListFilter size={20} />}
                <p className="filetable-empty__title">
                  {searchMode
                    ? 'Aucun fichier ne correspond'
                    : query
                      ? 'Aucun résultat dans ce dossier'
                      : 'Dossier vide'}
                </p>
                <p className="filetable-empty__text">
                  {searchMode
                    ? remote
                      ? 'La recherche interroge tout ce compte Google. Essayez un autre terme.'
                      : 'La recherche couvre tous les comptes. Essayez un autre terme.'
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

    </div>
  );
}
