import { useMemo } from 'react';
import {
  ArrowRight,
  ChevronRight,
  CloudCog,
  Download,
  HardDriveDownload,
  Plus,
  Sparkles,
  Star,
  TrendingUp,
} from 'lucide-react';
import { PROVIDER_LIST, PROVIDERS, type FileType, type ProviderId } from '../data/catalog';
import { useCatalog, useStore, type CatalogEntry, type Route } from '../store';
import {
  formatBytes,
  formatDecimal,
  formatNumber,
  formatRelative,
  formatSpeed,
  percent,
} from '../lib/format';
import { Meter, ProviderMark, TypeIcon } from '../components/visuals';
import { statusLabels } from '../lib/downloads';

interface HomeProps {
  onNavigate: (route: Route) => void;
  onOpenEntry: (entry: CatalogEntry) => void;
  onAddAccount: (provider?: ProviderId) => void;
}

export function Home({ onNavigate, onOpenEntry, onAddAccount }: HomeProps) {
  const { state } = useStore();
  const catalog = useCatalog();

  // Aucun compte connecté : l'accueil accueille au lieu d'afficher un tableau de
  // bord vide. C'est le premier écran que voit un nouvel utilisateur.
  const welcome = state.accounts.length === 0;

  const byProvider = useMemo(() => {
    const map = new Map<ProviderId, { accounts: number; used: number; quota: number }>();
    for (const provider of PROVIDER_LIST) {
      const accounts = state.accounts.filter((a) => a.provider === provider.id);
      map.set(provider.id, {
        accounts: accounts.length,
        used: accounts.reduce((sum, a) => sum + a.usedBytes, 0),
        quota: accounts.reduce((sum, a) => sum + a.quotaBytes, 0),
      });
    }
    return map;
  }, [state.accounts]);
  /** Nombre de fournisseurs ayant au moins un compte. */
  const activeProviders = useMemo(
    () => [...byProvider.values()].filter((entry) => entry.accounts > 0).length,
    [byProvider],
  );


  const totalUsed = state.accounts.reduce((sum, a) => sum + a.usedBytes, 0);
  const totalQuota = state.accounts.reduce((sum, a) => sum + a.quotaBytes, 0);
  const connected = state.accounts.filter((a) => a.status === 'connected').length;

  const transfers = state.downloads
    .filter((item) => item.status !== 'done')
    .sort((a, b) => a.received / a.size - b.received / b.size);
  const activeTransfers = transfers.filter((item) => item.status === 'active');
  const totalSpeed = activeTransfers.reduce((sum, item) => sum + item.speed, 0);
  const remainingBytes = transfers.reduce(
    (sum, item) => sum + (item.size - item.received),
    0,
  );
  const queueProgress = transfers.length
    ? transfers.reduce((sum, item) => sum + item.received, 0) /
      Math.max(
        transfers.reduce((sum, item) => sum + item.size, 0),
        1,
      )
    : 0;

  // Les comptes partagent des modèles proches : on garde un seul exemplaire
  // par nom de fichier pour proposer un aperçu varié.
  const recents = useMemo(() => {
    const seen = new Set<string>();
    return [...catalog.entries]
      .filter((entry) => !entry.node.children && entry.node.type !== 'folder')
      .sort(
        (a, b) => new Date(b.node.modified).getTime() - new Date(a.node.modified).getTime(),
      )
      .filter((entry) => {
        const key = `${entry.node.name}:${entry.parentPath.join('/')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 7);
  }, [catalog.entries]);

  const favoriteEntries = useMemo(
    () =>
      state.favorites
        .map((fav) => catalog.byKey.get(`${fav.accountId}::${fav.path.join('/')}`))
        .filter((entry): entry is CatalogEntry => Boolean(entry))
        .slice(0, 5),
    [state.favorites, catalog.byKey],
  );

  const today = useMemo(
    () =>
      new Intl.DateTimeFormat('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date()),
    [],
  );

  if (welcome) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="page-head__text">
            <div className="home-greeting">
              <Sparkles size={12} />
              <span className="home-greeting__date">{today}</span>
            </div>
            <h1 className="page-title">Votre espace cloud, réuni.</h1>
            <p className="page-subtitle">
              Cette application réunit vos comptes cloud dans une seule fenêtre. Elle
              n’envoie rien sur Internet, ne copie aucun fichier sans votre demande et ne
              stocke aucun mot de passe.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="empty">
            <span className="empty__icon">
              <CloudCog size={20} />
            </span>
            <p className="empty__title">Aucun compte connecté</p>
            <p className="empty__text">
              Connectez votre compte Google pour explorer vos fichiers depuis cette fenêtre.
              L’application demande uniquement l’autorisation de <b>lire</b> : elle ne peut
              ni modifier, ni déplacer, ni supprimer quoi que ce soit chez Google.
            </p>
            <div className="empty__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => onAddAccount('gdrive')}
              >
                <Plus size={14} strokeWidth={2.4} />
                Connecter Google Drive
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => onNavigate({ name: 'settings' })}
              >
                Voir les réglages
              </button>
            </div>
          </div>
        </div>

        <div className="grid-2 section">
          <section>
            <div className="section-head">
              <h2 className="section-title">Ce que fait l’application</h2>
            </div>
            <div className="panel">
              {[
                ['Parcourir', 'Naviguer dans vos dossiers Google Drive sans rien télécharger.'],
                ['Rechercher', 'Trouver un fichier par son nom directement chez Google.'],
                ['Télécharger', 'Enregistrer un fichier de votre Drive sur ce disque.'],
              ].map(([title, text]) => (
                <div className="list-row" key={title}>
                  <span className="list-row__main">
                    <span className="list-row__title">{title}</span>
                    <span className="list-row__meta">{text}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="section-head">
              <h2 className="section-title">Vos données restent chez vous</h2>
            </div>
            <div className="panel">
              {[
                ['Aucun mot de passe', 'La connexion se fait dans votre navigateur, jamais ici.'],
                ['Jeton chiffré', 'L’autorisation est chiffrée par Windows (DPAPI).'],
                ['Lecture seule', 'Aucune écriture n’est possible dans votre Drive.'],
              ].map(([title, text]) => (
                <div className="list-row" key={title}>
                  <span className="list-row__main">
                    <span className="list-row__title">{title}</span>
                    <span className="list-row__meta">{text}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="home-greeting">
            <Sparkles size={12} />
            <span className="home-greeting__date">{today}</span>
          </div>
          <h1 className="page-title">Votre espace cloud, réuni.</h1>
          <div className="home-summary">
            <span className="summary-stat">
              <b>{formatNumber(state.accounts.length)}</b>{' '}
              {state.accounts.length > 1 ? 'comptes' : 'compte'}
            </span>
            <span className="summary-stat">
              {/* Fournisseurs réellement utilisés : la liste des fournisseurs
                  connus ne doit pas faire croire que tous sont connectés. */}
              <b>{formatNumber(activeProviders)}</b>{' '}
              {activeProviders > 1 ? 'fournisseurs' : 'fournisseur'}
            </span>
            <span className="summary-stat">
              <b>{formatBytes(totalUsed)}</b> utilisés sur {formatBytes(totalQuota)}
            </span>
          </div>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn" onClick={() => onNavigate({ name: 'files' })}>
            <CloudCog size={14} />
            Explorer
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onAddAccount()}
          >
            <Plus size={14} strokeWidth={2.4} />
            Ajouter un compte
          </button>
        </div>
      </div>

      <div className="cloud-strip">
        {PROVIDER_LIST.map((provider) => {
          const stats = byProvider.get(provider.id);
          const ratio = stats && stats.quota ? stats.used / stats.quota : 0;
          return (
            <button
              key={provider.id}
              type="button"
              className="cloud-tile"
              style={{ ['--brand' as string]: provider.brand }}
              onClick={() => onNavigate({ name: 'clouds', provider: provider.id })}
            >
              <div className="cloud-tile__top">
                <ProviderMark provider={provider.id} />
                <span className="cloud-tile__name">{provider.name}</span>
                <span className="cloud-tile__meta tnum">
                  {formatDecimal(stats?.accounts ?? 0)}
                </span>
                <ArrowRight size={13} className="cloud-tile__arrow" />
              </div>
              <div className="cloud-tile__quota">
                <Meter value={ratio} tone={provider.brand} />
                <div className="cloud-tile__numbers">
                  <span>
                    <b>{formatBytes(stats?.used ?? 0)}</b>
                  </span>
                  <span>{percent(ratio)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid-2 section">
        <div className="stack">
          <section>
            <div className="section-head">
              <h2 className="section-title">
                Téléchargements en cours
                {activeTransfers.length ? (
                  <span className="section-title__count">{activeTransfers.length}</span>
                ) : null}
              </h2>
              <button
                type="button"
                className="section-link"
                onClick={() => onNavigate({ name: 'downloads' })}
              >
                Tout voir
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="panel">
              {transfers.length === 0 ? (
                <div className="empty" style={{ padding: '34px 24px' }}>
                  <span className="empty__icon">
                    <Download size={18} />
                  </span>
                  <p className="empty__title">Aucun transfert en cours</p>
                  <p className="empty__text">
                    Sélectionnez un fichier dans l’explorateur puis « Télécharger » pour
                    alimenter la file.
                  </p>
                  <div className="empty__actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => onNavigate({ name: 'files' })}
                    >
                      Ouvrir l’explorateur
                    </button>
                  </div>
                </div>
              ) : (
                transfers.slice(0, 4).map((item) => {
                  const ratio = item.received / item.size;
                  const isActive = item.status === 'active';
                  return (
                    <div className="transfer-mini" key={item.id}>
                      <div className="transfer-mini__top">
                        <TypeIcon type={item.type} size={12} small />
                        <span className="transfer-mini__name">{item.name}</span>
                        {isActive ? (
                          <span className="transfer-mini__pct tnum">
                            {percent(ratio)}
                          </span>
                        ) : (
                          <span className="badge">{statusLabels[item.status]}</span>
                        )}
                      </div>
                      <div className={isActive ? 'progress-running' : undefined}>
                        <Meter value={ratio} />
                      </div>
                      <div className="transfer-mini__bottom">
                        <span>
                          {PROVIDERS[item.provider].name} · <b>{item.accountName}</b>
                        </span>
                        <span>
                          {isActive ? formatSpeed(item.speed) : '—'} ·{' '}
                          {formatBytes(item.size)}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section>
            <div className="section-head">
              <h2 className="section-title">Derniers fichiers</h2>
              <button
                type="button"
                className="section-link"
                onClick={() => onNavigate({ name: 'files' })}
              >
                Explorateur
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="panel">
              {recents.map((entry) => {
                const account = state.accounts.find((a) => a.id === entry.accountId);
                return (
                  <button
                    key={`${entry.accountId}-${entry.path.join('/')}`}
                    type="button"
                    className="recent-row"
                    onClick={() => onOpenEntry(entry)}
                  >
                    <TypeIcon type={entry.node.type as FileType} size={12} small />
                    <span className="recent-row__main">
                      <span className="recent-row__name">{entry.node.name}</span>
                      <span className="recent-row__meta">
                        {account ? (
                          <ProviderMark provider={account.provider} size="sm" />
                        ) : null}
                        {account?.name}
                        <span className="dot-sep" />
                        /{entry.parentPath.join('/') || 'Racine'}
                      </span>
                    </span>
                    <span className="recent-row__size">{formatBytes(entry.node.size)}</span>
                    <span className="recent-row__date">
                      {formatRelative(entry.node.modified)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        </div>

        <div className="stack">
          <section>
            <div className="section-head">
              <h2 className="section-title">Activité réseau</h2>
            </div>
            <div className="panel" style={{ padding: '13px 14px' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  marginBottom: 11,
                }}
              >
                <span className="summary-cell__icon summary-cell__icon--accent">
                  <TrendingUp size={14} />
                </span>
                <div className="summary-cell__body">
                  <span className="summary-cell__value tnum">{formatSpeed(totalSpeed)}</span>
                  <span className="summary-cell__label">Débit total</span>
                </div>
                <span className="badge badge--ok" style={{ marginLeft: 'auto' }}>
                  <span className="dot dot--ok" />
                  {formatDecimal(activeTransfers.length)} actif
                  {activeTransfers.length > 1 ? 's' : ''}
                </span>
              </div>
              <div className="cloud-tile__numbers" style={{ marginBottom: 6 }}>
                <span>
                  Reste · <b>{formatBytes(remainingBytes)}</b>
                </span>
                <span>
                  File · <b>{formatDecimal(transfers.length)}</b> sur{' '}
                  <b>{formatDecimal(state.settings.concurrent)}</b>
                </span>
              </div>
              <Meter value={queueProgress} />
              <button
                type="button"
                className="btn btn--sm btn--block"
                style={{ marginTop: 11 }}
                onClick={() => onNavigate({ name: 'downloads' })}
              >
                <HardDriveDownload size={13} />
                Gérer la file
              </button>
            </div>
          </section>

          <section>
            <div className="section-head">
              <h2 className="section-title">
                Comptes connectés
                <span className="section-title__count">
                  {connected}/{state.accounts.length}
                </span>
              </h2>
            </div>
            <div className="panel">
              {PROVIDER_LIST.map((provider) => {
                const accounts = state.accounts.filter((a) => a.provider === provider.id);
                const online = accounts.filter((a) => a.status !== 'expired').length;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className="list-row list-row--button"
                    onClick={() => onNavigate({ name: 'clouds', provider: provider.id })}
                  >
                    <ProviderMark provider={provider.id} />
                    <span className="list-row__main">
                      <span className="list-row__title">{provider.name}</span>
                      <span className="list-row__meta">
                        {formatDecimal(online)} {online > 1 ? 'actifs' : 'actif'}
                        <span className="dot-sep" />
                        {formatDecimal(accounts.length)} au total
                      </span>
                    </span>
                    <ChevronRight size={14} className="muted" />
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="section-head">
              <h2 className="section-title">Favoris</h2>
              <button
                type="button"
                className="section-link"
                onClick={() => onNavigate({ name: 'favorites' })}
              >
                Tout voir
                <ChevronRight size={13} />
              </button>
            </div>
            <div className="panel">
              {favoriteEntries.length === 0 ? (
                <div className="empty" style={{ padding: '26px 20px' }}>
                  <span className="empty__icon">
                    <Star size={17} />
                  </span>
                  <p className="empty__title">Aucun favori</p>
                  <p className="empty__text">
                    Cliquez sur l’étoile d’un fichier pour le retrouver ici.
                  </p>
                </div>
              ) : (
                favoriteEntries.map((entry) => {
                  const account = state.accounts.find((a) => a.id === entry.accountId);
                  return (
                    <button
                      key={`${entry.accountId}-${entry.path.join('/')}`}
                      type="button"
                      className="fav-mini"
                      onClick={() => onOpenEntry(entry)}
                    >
                      <TypeIcon type={entry.node.type as FileType} size={11} small />
                      <span className="fav-mini__name">{entry.node.name}</span>
                      <span className="fav-mini__meta">
                        {account ? PROVIDERS[account.provider].name : '—'}
                      </span>
                      <Star size={12} fill="currentColor" style={{ color: 'var(--accent)' }} />
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <div className="panel" style={{ padding: '13px 14px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 11.5, fontWeight: 550 }}>Occupation totale</span>
              <span
                className="tnum"
                style={{ fontSize: 11, color: 'var(--text-3)' }}
              >
                {percent(totalQuota ? totalUsed / totalQuota : 0)}
              </span>
            </div>
            <Meter value={totalQuota ? totalUsed / totalQuota : 0} tall />
            <div
              className="cloud-tile__numbers"
              style={{ marginTop: 7, marginBottom: 10 }}
            >
              <span>
                <b>{formatBytes(totalUsed)}</b> utilisés
              </span>
              <span>{formatBytes(totalQuota)} disponibles</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[...PROVIDER_LIST]
                .map((provider) => {
                  const stats = byProvider.get(provider.id);
                  return { provider, used: stats?.used ?? 0 };
                })
                .sort((a, b) => b.used - a.used)
                .slice(0, 4)
                .map(({ provider, used }) => (
                  <div
                    key={provider.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      fontSize: 10.5,
                      color: 'var(--text-4)',
                    }}
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
                    <span style={{ flex: 1, color: 'var(--text-3)' }}>
                      {provider.name}
                    </span>
                    <span className="tnum">{formatBytes(used)}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
