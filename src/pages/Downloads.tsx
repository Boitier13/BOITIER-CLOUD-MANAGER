import { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  TriangleAlert,
  Download,
  FolderOpen,
  Gauge,
  Pause,
  Play,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { PROVIDERS, type FileType } from '../data/catalog';
import { useCatalog, useStore, type Route } from '../store';
import { formatBytes, formatDecimal, formatSpeed, percent } from '../lib/format';
import { formatEta, statusLabels, type DownloadStatus } from '../lib/downloads';
import { Meter, ProviderMark, TypeIcon } from '../components/visuals';
import { getBridge } from '../lib/bridge';
import { useToast } from '../components/toast';

const STATUS_BADGE: Record<DownloadStatus, string> = {
  active: 'badge--accent',
  queued: '',
  paused: 'badge--warn',
  done: 'badge--ok',
  error: 'badge--danger',
};

const FILTERS = [
  { id: 'all', label: 'Tous' },
  { id: 'active', label: 'En cours' },
  { id: 'queued', label: 'En attente' },
  { id: 'paused', label: 'En pause' },
  { id: 'done', label: 'Terminés' },
  { id: 'error', label: 'Échecs' },
] as const;

export function Downloads({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { state, dispatch } = useStore();
  const catalog = useCatalog();
  const toast = useToast();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all');

  const counts = useMemo(() => {
    const map: Record<string, number> = { all: state.downloads.length };
    for (const item of state.downloads) {
      map[item.status] = (map[item.status] ?? 0) + 1;
    }
    return map;
  }, [state.downloads]);

  const items = useMemo(() => {
    const list = [...state.downloads].sort(
      (a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime(),
    );
    return filter === 'all' ? list : list.filter((item) => item.status === filter);
  }, [state.downloads, filter]);

  const active = state.downloads.filter((item) => item.status === 'active');
  const queued = state.downloads.filter((item) => item.status === 'queued');
  const done = state.downloads.filter((item) => item.status === 'done');
  const speed = active.reduce((sum, item) => sum + item.speed, 0);
  const remaining = state.downloads
    .filter((item) => item.status !== 'done' && item.status !== 'error')
    .reduce((sum, item) => sum + Math.max(item.size - item.received, 0), 0);
  const totalDone = done.reduce((sum, item) => sum + item.size, 0);

  // Suggest recent files not already in the queue.
  const suggestions = useMemo(() => {
    const inQueue = new Set(state.downloads.map((item) => item.name));
    const accountsById = new Map(state.accounts.map((account) => [account.id, account]));
    const seen = new Set<string>();
    return [...catalog.entries]
      // Un compte réel n'est pas indexé : ses suggestions viendraient de dossiers
      // non visités, et le transfert direct se fait depuis l'explorateur.
      .filter((entry) => accountsById.get(entry.accountId)?.source !== 'google')
      .filter((entry) => entry.node.type === 'video' && !inQueue.has(entry.node.name))
      .filter((entry) => {
        if (seen.has(entry.node.name)) return false;
        seen.add(entry.node.name);
        return true;
      })
      .sort((a, b) => new Date(b.node.modified).getTime() - new Date(a.node.modified).getTime())
      .slice(0, 3)
      .map((entry) => ({ entry, account: accountsById.get(entry.accountId) }))
      .filter((item) => item.account);
  }, [catalog.entries, state.downloads, state.accounts]);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Transferts</div>
          <h1 className="page-title">Téléchargements</h1>
          <p className="page-subtitle">
            {state.downloads.some((item) => item.remoteId)
              ? 'Les fichiers Google Drive sont réellement enregistrés sur ce disque. Les autres transferts restent des simulations.'
              : 'File de démonstration — progression, débit et statuts simulés localement. Aucun fichier n’est réellement téléchargé.'}
          </p>
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => dispatch({ type: 'downloads/pauseAll' })}
            disabled={!active.length && !queued.length}
          >
            <Pause size={13} />
            Tout suspendre
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => {
              dispatch({ type: 'downloads/resumeAll' });
              toast.push('Transferts en pause relancés');
            }}
            disabled={!state.downloads.some((item) => item.status === 'paused')}
          >
            <Play size={13} />
            Tout reprendre
          </button>
        </div>
      </div>

      <div className="downloads-summary">
        <div className="summary-cell">
          <span className="summary-cell__icon summary-cell__icon--accent">
            <Gauge size={14} />
          </span>
          <div className="summary-cell__body">
            <span className="summary-cell__value tnum">{formatSpeed(speed)}</span>
            <span className="summary-cell__label">
              {state.downloads.some((item) => item.remoteId) ? 'Débit total' : 'Débit total simulé'}
            </span>
          </div>
        </div>
        <div className="summary-cell">
          <span className="summary-cell__icon">
            <Download size={14} />
          </span>
          <div className="summary-cell__body">
            <span className="summary-cell__value tnum">
              {formatDecimal(active.length)} / {formatDecimal(state.settings.concurrent)}
            </span>
            <span className="summary-cell__label">Actifs · limite configurée</span>
          </div>
        </div>
        <div className="summary-cell">
          <span className="summary-cell__icon">
            <ArrowDownToLine size={14} />
          </span>
          <div className="summary-cell__body">
            <span className="summary-cell__value tnum">{formatBytes(remaining)}</span>
            <span className="summary-cell__label">Reste à recevoir</span>
          </div>
        </div>
        <div className="summary-cell">
          <span className="summary-cell__icon">
            <Check size={14} />
          </span>
          <div className="summary-cell__body">
            <span className="summary-cell__value tnum">{formatBytes(totalDone)}</span>
            <span className="summary-cell__label">Terminé ({formatDecimal(done.length)})</span>
          </div>
        </div>
        <div className="summary-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => dispatch({ type: 'downloads/clearDone' })}
            disabled={!done.length}
          >
            <Trash2 size={12} />
            Vider les terminés
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onNavigate({ name: 'files' })}
          >
            <FolderOpen size={12} />
            Choisir un fichier
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="segmented">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`segmented__item${filter === item.id ? ' is-active' : ''}`}
              onClick={() => setFilter(item.id)}
            >
              {item.label}
              <span className="segmented__count tnum">{formatDecimal(counts[item.id] ?? 0)}</span>
            </button>
          ))}
        </div>
        <div className="filter-bar__spacer" />
        <span className="badge">
          Dossier cible · <b style={{ color: 'var(--text-2)', fontWeight: 500 }}>
            {state.settings.downloadFolder.split('\\').pop()}
          </b>
        </span>
      </div>

      <div className="panel">
        {items.length === 0 ? (
          <div className="empty">
            <span className="empty__icon">
              <Download size={18} />
            </span>
            <p className="empty__title">
              {filter === 'all' ? 'La file est vide' : 'Aucun transfert dans cette catégorie'}
            </p>
            <p className="empty__text">
              Ouvrez un fichier depuis l’explorateur ou ajoutez une suggestion ci-dessous
              pour simuler un téléchargement.
            </p>
            <div className="empty__actions">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => onNavigate({ name: 'files' })}
              >
                Ouvrir l’explorateur
              </button>
            </div>
          </div>
        ) : (
          items.map((item) => {
            const ratio = item.received / Math.max(item.size, 1);
            const account = state.accounts.find((a) => a.id === item.accountId);
            return (
              <div className="download-row" key={item.id}>
                <TypeIcon type={item.type as FileType} size={13} />
                <div className="download-row__main">
                  <div className="download-row__title">
                    <span className="download-row__name" title={item.name}>
                      {item.name}
                    </span>
                  </div>
                  <div className="download-row__meta">
                    {account ? <ProviderMark provider={account.provider} size="sm" /> : null}
                    {PROVIDERS[item.provider].name}
                    <span className="dot-sep" />
                    {item.accountName}
                    <span className="dot-sep" />
                    {formatBytes(item.size)}
                    {item.remoteId ? (
                      <>
                        <span className="dot-sep" />
                        <span style={{ color: 'var(--accent)' }}>Réel</span>
                      </>
                    ) : null}
                  </div>
                  {item.status === 'error' && item.error ? (
                    <div className="download-row__note">
                      <TriangleAlert size={11} />
                      {item.error}
                    </div>
                  ) : null}
                  <div
                    className={`download-row__progress${
                      item.status === 'active' ? ' progress-running' : ''
                    }`}
                  >
                    <Meter value={ratio} />
                    <span className="download-row__pct tnum">{percent(ratio)}</span>
                  </div>
                </div>
                <div className="download-row__speed">
                  {item.status === 'active' ? formatSpeed(item.speed) : '—'}
                  <small>
                    {item.status === 'active'
                      ? `${formatEta(item)} restants`
                      : item.status === 'done'
                        ? item.savedPath
                          ? 'Enregistré'
                          : 'Terminé'
                        : item.status === 'error'
                          ? 'Interrompu'
                          : `${formatBytes(Math.max(item.size - item.received, 0))}`}
                  </small>
                </div>
                <div className="download-row__status">
                  <span className={`badge ${STATUS_BADGE[item.status]}`}>
                    {item.status === 'active' ? (
                      <span className="dot dot--ok" />
                    ) : null}
                    {statusLabels[item.status]}
                  </span>
                </div>
                <div className="download-row__actions">
                  {item.status === 'active' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Suspendre"
                      aria-label="Suspendre le téléchargement"
                      onClick={() => dispatch({ type: 'downloads/pause', id: item.id })}
                    >
                      <Pause size={13} />
                    </button>
                  ) : null}
                  {item.status === 'paused' || item.status === 'queued' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Reprendre"
                      aria-label="Reprendre le téléchargement"
                      onClick={() => {
                        dispatch({ type: 'downloads/resume', id: item.id });
                        toast.push(`Reprise de ${item.name}`);
                      }}
                    >
                      <Play size={13} />
                    </button>
                  ) : null}
                  {item.status === 'done' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title={item.savedPath ? 'Afficher dans le dossier' : 'Relancer la simulation'}
                      aria-label="Relancer le téléchargement"
                      onClick={() => {
                        if (item.savedPath) {
                          void getBridge()?.google.openFolder?.(item.savedPath);
                          return;
                        }
                        toast.push('Fichier déjà présent dans le dossier cible', 'warn');
                      }}
                    >
                      <RotateCw size={13} />
                    </button>
                  ) : null}
                  {item.status === 'error' && item.remoteId ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Réessayer"
                      aria-label="Réessayer le téléchargement"
                      onClick={() => {
                        dispatch({ type: 'downloads/resume', id: item.id });
                        toast.push(`Nouvelle tentative pour ${item.name}`);
                      }}
                    >
                      <RotateCw size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-btn"
                    title="Annuler le transfert"
                    aria-label="Annuler le transfert"
                    onClick={() => {
                      dispatch({ type: 'downloads/cancel', id: item.id });
                      toast.push(
                        item.remoteId ? 'Téléchargement annulé, fichier partiel supprimé' : 'Transfert annulé',
                        'warn',
                      );
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {suggestions.length > 0 ? (
        <div className="section">
          <div className="section-head">
            <h2 className="section-title">Suggestions récentes</h2>
            <button
              type="button"
              className="section-link"
              onClick={() => onNavigate({ name: 'files' })}
            >
              Parcourir tout
            </button>
          </div>
          <div className="panel">
            {suggestions.map(({ entry, account }) => (
              <div className="list-row" key={`${entry.accountId}-${entry.path.join('/')}`}>
                <TypeIcon type={entry.node.type} size={13} />
                <span className="list-row__main">
                  <span className="list-row__title">{entry.node.name}</span>
                  <span className="list-row__meta">
                    {account ? <ProviderMark provider={account.provider} size="sm" /> : null}
                    {account?.name}
                    <span className="dot-sep" />
                    {formatBytes(entry.node.size)}
                    <span className="dot-sep" />
                    /{entry.parentPath.join('/')}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    if (!account) return;
                    dispatch({
                      type: 'downloads/add',
                      items: [
                        {
                          id: `${entry.node.id}-${Date.now()}`,
                          name: entry.node.name,
                          type: entry.node.type,
                          size: entry.node.size,
                          received: 0,
                          speed: 0,
                          baseSpeed: 28 * 1024 * 1024,
                          status: 'queued',
                          provider: account.provider,
                          accountId: account.id,
                          accountName: account.name,
                          path: entry.path,
                          addedAt: new Date().toISOString(),
                        },
                      ],
                    });
                    toast.push('Ajouté à la file', 'ok');
                  }}
                >
                  <ArrowDownToLine size={12} />
                  Ajouter
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
