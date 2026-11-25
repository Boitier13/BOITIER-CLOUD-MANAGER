import { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  FolderOpen,
  Search,
  Star,
  StarOff,
  X,
} from 'lucide-react';
import { PROVIDER_LIST, PROVIDERS } from '../data/catalog';
import {
  catalogKey,
  useCatalog,
  useStore,
  type CatalogEntry,
} from '../store';
import {
  formatBytes,
  formatDecimal,
  formatRelative,
  normalize,
  plural,
} from '../lib/format';
import { Meter, ProviderMark, TypeIcon } from '../components/visuals';
import { createDownload } from '../lib/downloads';
import { displaySegment } from '../lib/remote';
import { getBridge } from '../lib/bridge';
import { useToast } from '../components/toast';

interface FavoritesProps {
  onOpenEntry: (entry: CatalogEntry) => void;
}

export function Favorites({ onOpenEntry }: FavoritesProps) {
  const { state, dispatch } = useStore();
  const catalog = useCatalog();
  const toast = useToast();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = normalize(query.trim());
    return state.favorites
      .map((fav) => {
        const entry = catalog.byKey.get(catalogKey(fav.accountId, fav.path));
        const account = state.accounts.find((a) => a.id === fav.accountId);
        if (!entry || !account) return null;
        return { fav, entry, account };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row))
      .filter(({ entry, account }) => {
        if (!q) return true;
        const haystack = normalize(
          `${entry.node.name} ${PROVIDERS[account.provider].name} ${account.name} ${entry.path
            .map(displaySegment)
            .join('/')}`,
        );
        return haystack.includes(q);
      })
      .sort((a, b) => new Date(b.fav.addedAt).getTime() - new Date(a.fav.addedAt).getTime());
  }, [state.favorites, state.accounts, catalog.byKey, query]);

  const totalWeight = rows.reduce((sum, row) => sum + row.entry.node.size, 0);

  // Répartition par fournisseur (sur l'ensemble des favoris, pas seulement le filtre).
  const breakdown = PROVIDER_LIST.map((provider) => {
    const items = state.favorites
      .map((fav) => catalog.byKey.get(catalogKey(fav.accountId, fav.path)))
      .filter((entry): entry is CatalogEntry => Boolean(entry))
      .filter((entry) => {
        const account = state.accounts.find((a) => a.id === entry.accountId);
        return account?.provider === provider.id;
      });
    return {
      provider,
      count: items.length,
      size: items.reduce((sum, entry) => sum + entry.node.size, 0),
    };
  }).filter((row) => row.count > 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Collection</div>
          <h1 className="page-title">Favoris</h1>
          <p className="page-subtitle">
            {plural(state.favorites.length, 'fichier épinglé', 'fichiers épinglés')} à travers
            tous vos comptes. Retrouvez le cloud, le compte, la taille et l’emplacement de
            chaque élément.
          </p>
        </div>
        <div className="page-head__actions">
          <div className="search" style={{ width: 230 }}>
            <Search size={13} />
            <input
              className="input"
              placeholder="Rechercher un favori…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Rechercher dans les favoris"
            />
            {query ? (
              <button
                type="button"
                className="search__clear"
                onClick={() => setQuery('')}
                aria-label="Effacer la recherche"
              >
                <X size={12} />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="filter-bar">
        <span className="badge badge--accent">
          <Star size={11} fill="currentColor" />
          {plural(rows.length, 'élément', 'éléments')}
        </span>
        <span className="badge">{formatBytes(totalWeight)} au total</span>
        <div className="filter-bar__spacer" />
        <span className="filter-hint">
          Cliquez sur l’étoile dans l’explorateur pour ajouter ou retirer un fichier.
        </span>
      </div>

      <div className="grid-2">
      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">
            <span className="empty__icon">
              <Star size={18} />
            </span>
            <p className="empty__title">
              {query ? 'Aucun favori ne correspond' : 'Votre collection est vide'}
            </p>
            <p className="empty__text">
              {query
                ? 'Essayez un autre terme de recherche.'
                : 'Ouvrez l’explorateur et cliquez sur l’étoile d’un fichier pour l’épingler ici.'}
            </p>
            {query ? (
              <div className="empty__actions">
                <button type="button" className="btn btn--sm" onClick={() => setQuery('')}>
                  Effacer la recherche
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          rows.map(({ fav, entry, account }) => (
            <div className="fav-row" key={`${fav.accountId}-${fav.path.join('/')}`}>
              <TypeIcon type={entry.node.type} size={13} />
              <div className="fav-row__main">
                <button
                  type="button"
                  className="fav-row__name"
                  onClick={() => onOpenEntry(entry)}
                  title={`Ouvrir ${entry.parentPath.join(' / ') || 'la racine'}`}
                >
                  {entry.node.name}
                </button>
                <div className="fav-row__meta">
                  <ProviderMark provider={account.provider} size="sm" />
                  <span className="fav-row__provider">
                    {PROVIDERS[account.provider].name}
                  </span>
                  <span className="dot-sep" />
                  <span>{account.name}</span>
                  <span className="dot-sep" />
                  <span
                    className="fav-row__path"
                    title={entry.parentPath.map(displaySegment).join(' / ')}
                  >
                    {entry.parentPath.length ? entry.parentPath.join(' / ') : 'Racine'}
                  </span>
                </div>
              </div>
              <div className="fav-row__side">
                <div className="fav-row__numbers">
                  <span className="fav-row__size">{formatBytes(entry.node.size)}</span>
                  <span className="fav-row__added">{formatRelative(fav.addedAt)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    const real = account.source === 'google' && account.googleId;
                    const item = createDownload({
                      id: `${entry.node.id}-${Date.now()}`,
                      name: entry.node.name,
                      type: entry.node.type,
                      size: entry.node.size,
                      provider: account.provider,
                      accountId: account.id,
                      accountName: account.name,
                      path: entry.path,
                      seed: entry.node.name.length * 5,
                      ...(real && account.googleId
                        ? { remoteId: entry.node.id, remoteAccount: account.googleId }
                        : {}),
                    });
                    dispatch({ type: 'downloads/add', items: [item] });
                    if (real && account.googleId) {
                      void getBridge()
                        ?.google.download({
                          id: item.id,
                          accountId: account.googleId,
                          fileId: entry.node.id,
                          name: entry.node.name,
                          size: entry.node.size,
                          dir: state.settings.downloadFolder,
                        })
                        .catch((cause: Error) =>
                          toast.push(cause.message || 'Téléchargement impossible', 'error'),
                        );
                    } else {
                      toast.push('Ajouté à la file de téléchargement', 'ok');
                    }
                  }}
                >
                  <ArrowDownToLine size={12} />
                  Télécharger
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Ouvrir l’emplacement"
                  aria-label="Ouvrir l’emplacement"
                  onClick={() => onOpenEntry(entry)}
                >
                  <FolderOpen size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="Retirer des favoris"
                  aria-label="Retirer des favoris"
                  onClick={() => {
                    dispatch({
                      type: 'favorite/remove',
                      accountId: fav.accountId,
                      path: fav.path,
                    });
                    toast.push('Retiré des favoris');
                  }}
                >
                  <StarOff size={14} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>

        <div className="stack">
          <section>
            <div className="section-head">
              <h2 className="section-title">Répartition</h2>
              <span className="section-title__count">{formatDecimal(state.favorites.length)}</span>
            </div>
            <div className="panel">
              {breakdown.length === 0 ? (
                <div className="empty" style={{ padding: '22px 18px' }}>
                  <p className="empty__text">Aucun favori enregistré.</p>
                </div>
              ) : (
                breakdown.map((row) => (
                  <div key={row.provider.id} className="breakdown-row">
                    <ProviderMark provider={row.provider.id} />
                    <div className="breakdown-row__main">
                      <div className="breakdown-row__top">
                        <span>{row.provider.name}</span>
                        <span className="tnum">
                          {formatDecimal(row.count)} · {formatBytes(row.size)}
                        </span>
                      </div>
                      <Meter
                        value={
                          state.favorites.length ? row.count / state.favorites.length : 0
                        }
                      />
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <div className="panel" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
              <FolderOpen size={12} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 11.5, fontWeight: 550 }}>Emplacement d’origine</span>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-4)', lineHeight: 1.55 }}>
              Chaque favori reste lié à son compte et à son chemin exact. Cliquez sur son nom
              pour rouvrir directement le dossier correspondant.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
