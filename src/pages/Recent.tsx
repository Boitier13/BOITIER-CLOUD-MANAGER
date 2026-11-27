import { useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  Clock,
  FolderOpen,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
} from 'lucide-react';
import { PROVIDERS } from '../data/catalog';
import { useStore, type Route } from '../store';
import { remoteCatalog, useRemoteRecent } from '../lib/remote';
import { isRealAccount, realAccountId } from '../lib/google';
import {
  formatBytes,
  formatDate,
  formatDecimal,
  formatRelative,
  normalize,
  plural,
} from '../lib/format';
import { ProviderMark, TypeIcon } from '../components/visuals';
import { createDownload } from '../lib/downloads';
import { getBridge } from '../lib/bridge';
import { downloadAccount } from '../lib/cloud';
import { useToast } from '../components/toast';

/**
 * Écran « Récents » — derniers fichiers modifiés, tous comptes confondus.
 *
 * **Ce que cet écran ne prétend pas faire.** Google Drive n'expose pas
 * d'historique d'ouverture : la seule date disponible est celle de *modification*.
 * Un fichier que vous consultez tous les jours mais que vous ne modifiez jamais
 * n'apparaîtra donc pas ici. C'est écrit en haut de l'écran plutôt que corrigé
 * par une invention : un faux « consulté récemment » serait pire que pas
 * d'écran du tout.
 *
 * Conséquence de conception : pas de filtre « ouverts par moi », pas d'onglet
 * « activité ». Ces vues demanderaient une donnée que l'API ne fournit pas.
 */

/** Fenêtres proposées, en jours. Bornées : au-delà, la liste n'a plus de sens. */
const WINDOWS = [
  { days: 7, label: '7 jours' },
  { days: 30, label: '30 jours' },
  { days: 90, label: '90 jours' },
] as const;

export function Recent({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [days, setDays] = useState<number>(30);
  const [query, setQuery] = useState('');

  // Seuls les comptes Google connectés peuvent alimenter ce flux : les autres
  // fournisseurs n'existent plus, et un compte expiré ne répondrait pas.
  const googleAccounts = useMemo(
    () => state.accounts.filter((account) => isRealAccount(account) && realAccountId(account)),
    [state.accounts],
  );
  const accountIds = useMemo(
    () => googleAccounts.map((account) => realAccountId(account) as string),
    [googleAccounts],
  );

  const recent = useRemoteRecent(accountIds, accountIds.length > 0);

  const rows = useMemo(() => {
    const q = normalize(query.trim());
    const since = Date.now() - days * 86_400_000;
    return recent.files
      .filter((row) => new Date(row.modified).getTime() >= since)
      .filter((row) => (q ? normalize(row.file.name).includes(q) : true))
      .map((row) => {
        const account = googleAccounts.find(
          (item) => realAccountId(item) === row.accountId,
        );
        return account ? { ...row, account } : null;
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));
  }, [recent.files, days, query, googleAccounts]);

  const totalSize = rows.reduce((sum, row) => sum + row.file.size, 0);
  /**
   * Ouvre l'explorateur sur le compte d'origine du fichier.
   *
   * On ne prétend pas atteindre l'emplacement exact : Drive ne renvoie que
   * l'identifiant du dossier parent, pas le chemin complet. Inventer un chemin
   * afficherait un fil d'Ariane faux — on préfère ouvrir la racine du compte et
   * laisser l'explorateur faire son travail.
   */
  const openAccount = (accountId: string) => {
    dispatch({ type: 'explorer/open', accountId });
    onNavigate({ name: 'files' });
  };

  const download = (row: (typeof rows)[number]) => {
    const googleId = realAccountId(row.account);
    const bridge = getBridge();
    if (!bridge || !googleId) {
      toast.push(
        'Téléchargement indisponible dans le navigateur — utilisez la version Windows',
        'warn',
      );
      return;
    }
    if (row.file.children) {
      toast.push('Ouvrez le dossier depuis l’explorateur pour le télécharger', 'warn');
      return;
    }
    const item = createDownload({
      id: `${row.file.id}-${Date.now()}`,
      name: row.file.name,
      type: row.file.type,
      size: row.file.size,
      provider: row.account.provider,
      accountId: row.account.id,
      accountName: row.account.name,
      path: [row.file.name],
      seed: row.file.name.length * 7 + row.file.size,
      remoteId: row.file.id,
      remoteAccount: googleId,
    });
    dispatch({ type: 'downloads/add', items: [item] });
    void downloadAccount({
        id: item.id,
        provider: row.account.provider,
        accountId: googleId,
        fileId: row.file.id,
        name: row.file.name,
        size: row.file.size,
        dir: state.settings.downloadFolder,
      })
      .catch((cause: Error) => toast.push(cause.message || 'Téléchargement impossible', 'error'));
  };

  if (!googleAccounts.length) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="page-head__text">
            <div className="page-eyebrow">Flux</div>
            <h1 className="page-title">Récents</h1>
            <p className="page-subtitle">
              Les derniers fichiers modifiés, tous vos comptes ensemble.
            </p>
          </div>
        </div>
        <div className="panel">
          <div className="empty">
            <span className="empty__icon">
              <Clock size={18} />
            </span>
            <p className="empty__title">Aucun compte à interroger</p>
            <p className="empty__text">
              Ce flux se construit à partir des dates de modification des fournisseurs connectés.
              Connectez un compte pour le voir se remplir.
            </p>
            <div className="empty__actions">
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => onNavigate({ name: 'clouds', provider: 'gdrive' })}
              >
                Connecter Google Drive
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Flux</div>
          <h1 className="page-title">Récents</h1>
          <p className="page-subtitle">
            Les derniers fichiers <b>modifiés</b>, tous comptes ensemble — Google ne
            transmet pas la date d’ouverture.
          </p>
        </div>
        <div className="page-head__actions">
          <div className="search" style={{ width: 220 }}>
            <Search size={13} />
            <input
              className="input"
              placeholder="Filtrer par nom…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Filtrer les fichiers récents"
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
        </div>
      </div>

      <div className="filter-bar">
        <div className="segmented" role="group" aria-label="Fenêtre de temps">
          {WINDOWS.map((option) => (
            <button
              key={option.days}
              type="button"
              className={`segmented__item${days === option.days ? ' is-active' : ''}`}
              onClick={() => setDays(option.days)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="badge">{plural(rows.length, 'élément', 'éléments')}</span>
        {rows.length ? <span className="badge">{formatBytes(totalSize)}</span> : null}
        <div className="filter-bar__spacer" />
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            // On invalide le cache puis on relit : sans cela, Actualiser ne
            // changerait rien à l'écran.
            for (const id of accountIds) remoteCatalog.reloadRecent(id);
            toast.push('Flux actualisé');
          }}
        >
          <RefreshCw size={12} />
          Actualiser
        </button>
      </div>

      <div className="panel">
        {recent.status === 'loading' && rows.length === 0 ? (
          <div className="filetable-loading">
            <RefreshCw size={13} className="spin" />
            Lecture des dates de modification…
          </div>
        ) : recent.status === 'error' && rows.length === 0 ? (
          <div className="filetable-error">
            <TriangleAlert size={18} />
            <p className="filetable-error__title">Flux indisponible</p>
            <p className="filetable-error__text">{recent.error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <span className="empty__icon">
              <Clock size={18} />
            </span>
            <p className="empty__title">
              {query ? 'Aucun nom ne correspond' : 'Rien de modifié sur cette période'}
            </p>
            <p className="empty__text">
              {query
                ? 'Le filtre porte uniquement sur les fichiers déjà affichés.'
                : `Aucun fichier n’a été modifié ces ${days} derniers jours. Élargissez la période ou modifiez un fichier dans votre cloud.`}
            </p>
            {query ? (
              <div className="empty__actions">
                <button type="button" className="btn btn--sm" onClick={() => setQuery('')}>
                  Effacer le filtre
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          rows.map((row) => (
            <div className="recent-row" key={`${row.account.id}-${row.file.id}`}>
              <TypeIcon type={row.file.type} size={13} />
              <div className="recent-row__main">
                <span className="recent-row__name" title={row.file.name}>
                  {row.file.name}
                </span>
                <div className="recent-row__meta">
                  <ProviderMark provider={row.account.provider} size="sm" />
                  <span>{PROVIDERS[row.account.provider].name}</span>
                  <span className="dot-sep" />
                  <span>{row.account.name}</span>
                  <span className="dot-sep" />
                  <span>{formatBytes(row.file.size)}</span>
                </div>
              </div>
              <div className="recent-row__when">
                <span title={formatDate(row.modified)}>{formatRelative(row.modified)}</span>
                <small>{formatDate(row.modified)}</small>
              </div>
              <div className="recent-row__actions">
                {row.file.children ? (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Ouvrir dans l’explorateur"
                    aria-label={`Ouvrir ${row.file.name}`}
                    onClick={() => openAccount(row.account.id)}
                  >
                    <FolderOpen size={13} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-btn"
                    title="Télécharger ce fichier"
                    aria-label={`Télécharger ${row.file.name}`}
                    onClick={() => download(row)}
                  >
                    <ArrowDownToLine size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => openAccount(row.account.id)}
                >
                  Ouvrir
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <p className="storage-note">
        {formatDecimal(rows.length)} élément{rows.length > 1 ? 's' : ''} sur les{' '}
        {days} derniers jours. Google Drive ne fournit que la date de{' '}
        <b>modification</b> : un fichier que vous consultez souvent sans le modifier
        n’apparaît pas ici.
      </p>
    </div>
  );
}
