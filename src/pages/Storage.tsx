import { useEffect, useMemo, useRef, useState } from 'react';
import { HardDrive, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { PROVIDER_IDS, PROVIDERS } from '../data/catalog';
import { useStore, type Route } from '../store';
import { getBridge, type GoogleStorageUsage } from '../lib/bridge';
import { isRealAccount, realAccountId } from '../lib/google';
import { formatBytes, formatDecimal, percent } from '../lib/format';
import { Meter, ProviderMark } from '../components/visuals';
import { useToast } from '../components/toast';

/**
 * Écran « Stockage ».
 *
 * Deux règles ont guidé cet écran :
 *
 *   1. **Rien d'inventé.** Le quota vient de Google (`about.get`) : il est exact.
 *      La répartition par catégorie est *mesurée* en additionnant des tailles de
 *      fichiers — donc bornée, parfois partielle, et signalée comme telle.
 *   2. **Rien d' inutile.** Pas de camembert décoratif : une seule barre de
 *      quota, puis des lignes chiffrées. Un chiffre faux serait pire que pas de
 *      chiffre.
 *
 * Quand Google distingue Drive / Gmail / Photos (`usage` ≠ `usageInDrive`), on
 * l'affiche ; sinon on se tait au lieu d'écrire « 0 o dans Gmail ».
 */

const CATEGORY_LABELS: Record<GoogleStorageUsage['categories'][number]['id'], string> = {
  document: 'Documents',
  image: 'Images',
  video: 'Vidéos',
  audio: 'Audio',
  archive: 'Archives',
  other: 'Texte et autres',
};

export function Storage({ onNavigate }: { onNavigate: (route: Route) => void }) {
  const { state } = useStore();
  const toast = useToast();
  const accounts = state.accounts;
  const [selectedId, setSelectedId] = useState<string>(accounts[0]?.id ?? '');
  const [usage, setUsage] = useState<GoogleStorageUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Évite de relancer une mesure déjà faite pour ce compte. */
  const measuredFor = useRef<string>('');
  const bridge = useMemo(() => getBridge(), []);

  const account = accounts.find((item) => item.id === selectedId) ?? accounts[0];
  const googleId = account ? realAccountId(account) : undefined;

  const measure = (id: string, force = false) => {
    // MEGA n'expose pas de répartition par catégorie : le quota vient de la
    // session (mesuré à la connexion et après chaque envoi), et il n'y a donc
    // rien de plus à demander ici. On ne lance pas une requête inutile.
    if (account?.provider !== 'gdrive') {
      setUsage(null);
      measuredFor.current = id;
      return;
    }
    if (!bridge?.google.storage || !id) return;
    if (!force && measuredFor.current === id) return;
    measuredFor.current = id;
    setLoading(true);
    setError(null);
    bridge.google
      .storage(id)
      .then((result) => setUsage(result))
      .catch((cause: Error) => {
        measuredFor.current = '';
        setError(cause?.message || 'La répartition du stockage n’a pas pu être lue.');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (googleId) measure(googleId);
    // La mesure ne dépend que du compte sélectionné.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [googleId]);

  const totals = accounts.reduce(
    (acc, item) => ({
      used: acc.used + item.usedBytes,
      quota: acc.quota + item.quotaBytes,
    }),
    { used: 0, quota: 0 },
  );

  if (!accounts.length) {
    return (
      <div className="page">
        <div className="page-head">
          <div className="page-head__text">
            <div className="page-eyebrow">Espace disque</div>
            <h1 className="page-title">Stockage</h1>
            <p className="page-subtitle">
              Répartition de l’espace utilisé, compte par compte.
            </p>
          </div>
        </div>
        <div className="panel">
          <div className="empty">
            <span className="empty__icon">
              <HardDrive size={18} />
            </span>
            <p className="empty__title">Aucun compte à mesurer</p>
            <p className="empty__text">
              Le quota affiché ici vient de chaque fournisseur lui-même. Connectez
              un compte pour voir son espace réel et la place occupée par vos
              fichiers.
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

  const measured = usage?.categories ?? [];
  const measuredTotal = measured.reduce((sum, category) => sum + category.bytes, 0);
  const incomplete = Boolean(usage?.partial);
  const unknownShare = Math.max(
    (usage?.usedBytes ?? account?.usedBytes ?? 0) - measuredTotal - (usage?.emailBytes ?? 0),
    0,
  );
  const largest = Math.max(...measured.map((category) => category.bytes), 1);

  /**
   * Comptes regroupés par fournisseur.
   *
   * Ils étaient présentés en une seule liste : vingt pastilles mêlant Google
   * Drive et MEGA, où l'on ne savait plus quel compte appartenait à quel
   * service. La liste suit `PROVIDER_IDS` : ajouter Shadow Drive ou TeraBox
   * suffit à faire apparaître leur groupe, sans toucher à cet écran.
   */
  const groupes = PROVIDER_IDS.map((id) => {
    const comptes = accounts.filter((item) => item.provider === id);
    return {
      provider: PROVIDERS[id],
      comptes,
      used: comptes.reduce((sum, item) => sum + item.usedBytes, 0),
      quota: comptes.reduce((sum, item) => sum + item.quotaBytes, 0),
    };
  }).filter((groupe) => groupe.comptes.length > 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Espace disque</div>
          <h1 className="page-title">Stockage</h1>
          <p className="page-subtitle">
            Chaque fournisseur est mesuré séparément : son quota vient de lui, et
            la répartition par type n’existe que là où il la publie.
          </p>
        </div>
        <div className="page-head__actions">
          <span className="badge" title="Tous les fournisseurs réunis">
            <HardDrive size={11} />
            Total {formatBytes(totals.used)} sur {formatBytes(totals.quota)}
          </span>
        </div>
      </div>

      {groupes.map((groupe) => (
        <section className="storage-group" key={groupe.provider.id}>
          <div className="section-head storage-group__head">
            <h2 className="section-title">
              <ProviderMark provider={groupe.provider.id} size="sm" />
              {groupe.provider.name}
            </h2>
            <span className="badge">
              {formatDecimal(groupe.comptes.length)} compte
              {groupe.comptes.length > 1 ? 's' : ''} · {formatBytes(groupe.used)} sur{' '}
              {formatBytes(groupe.quota)}
            </span>
          </div>
          <div className="filter-bar">
            <div
              className="segmented segmented--wrap"
              role="group"
              aria-label={`Compte ${groupe.provider.name} mesuré`}
            >
              {groupe.comptes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  // Deux comptes peuvent porter le même nom (une adresse
                  // « +N » sur Google, la même chez MEGA) : l'adresse lève le
                  // doute.
                  title={`${item.name} — ${item.email}`}
                  className={`segmented__item${item.id === account?.id ? ' is-active' : ''}`}
                  onClick={() => {
                    setSelectedId(item.id);
                    setUsage(null);
                    measuredFor.current = '';
                  }}
                >
                  {item.name}
                </button>
              ))}
            </div>
          </div>
        </section>
      ))}

      {!isRealAccount(account) ? (
        <div className="panel">
          <div className="empty">
            <span className="empty__icon">
              <HardDrive size={18} />
            </span>
            <p className="empty__title">Compte sans quota connu</p>
            <p className="empty__text">
              Ce compte n’est pas relié à un fournisseur : son espace ne peut pas
              être mesuré.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="panel storage-card">
            <div className="storage-card__head">
              <ProviderMark provider={account.provider} size="sm" />
              <div className="storage-card__id">
                <span className="storage-card__name">{account.name}</span>
                <span className="storage-card__email">{account.email}</span>
              </div>
              <span className="storage-card__quota tnum">
                {formatBytes(account.usedBytes)}
                <small> sur {formatBytes(account.quotaBytes)}</small>
              </span>
              <button
                type="button"
                className="icon-btn"
                title="Mesurer à nouveau"
                aria-label="Mesurer à nouveau"
                disabled={loading}
                onClick={() => {
                  measuredFor.current = '';
                  measure(googleId ?? '', true);
                  toast.push('Nouvelle mesure du stockage');
                }}
              >
                <RefreshCw size={13} className={loading ? 'spin' : undefined} />
              </button>
            </div>

            <Meter
              value={account.usedBytes / Math.max(account.quotaBytes, 1)}
              tone={PROVIDERS[account.provider].brand}
            />

            <div className="storage-card__figures">
              <div>
                <span className="storage-card__label">Utilisé</span>
                <b className="tnum">{formatBytes(account.usedBytes)}</b>
              </div>
              <div>
                <span className="storage-card__label">Libre</span>
                <b className="tnum">
                  {formatBytes(Math.max(account.quotaBytes - account.usedBytes, 0))}
                </b>
              </div>
              <div>
                <span className="storage-card__label">Occupation</span>
                <b className="tnum">
                  {percent(account.usedBytes / Math.max(account.quotaBytes, 1))}
                </b>
              </div>
            </div>
          </div>

          {account.provider === 'gdrive' ? (
          <>
          <div className="section-head" style={{ marginTop: 22 }}>
            <h2 className="section-title">Répartition par type</h2>
            {incomplete ? (
              <span className="badge badge--warn">
                <TriangleAlert size={11} />
                Partielle
              </span>
            ) : null}
          </div>

          <div className="panel">
            {loading && !usage ? (
              <div className="filetable-loading">
                <Loader2 size={13} className="spin" />
                Mesure des fichiers du compte…
              </div>
            ) : error ? (
              <div className="filetable-error">
                <TriangleAlert size={18} />
                <p className="filetable-error__title">Mesure impossible</p>
                <p className="filetable-error__text">{error}</p>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    measuredFor.current = '';
                    measure(googleId ?? '', true);
                  }}
                >
                  <RefreshCw size={12} />
                  Réessayer
                </button>
              </div>
            ) : (
              <div className="storage-list">
                {measured.map((category) => (
                  <div className="storage-row" key={category.id}>
                    <span className="storage-row__name">
                      {CATEGORY_LABELS[category.id]}
                      {category.partial ? (
                        <span className="storage-row__partial" title="Somme incomplète">
                          ≥
                        </span>
                      ) : null}
                    </span>
                    <span className="storage-row__bar">
                      <span
                        className="storage-row__fill"
                        style={{
                          width: `${Math.max((category.bytes / largest) * 100, category.bytes > 0 ? 2 : 0)}%`,
                        }}
                      />
                    </span>
                    <span className="storage-row__size tnum">
                      {formatBytes(category.bytes)}
                    </span>
                    <span className="storage-row__count tnum">
                      {formatDecimal(category.count)}
                      {category.partial ? '+' : ''} fichiers
                    </span>
                  </div>
                ))}

                {usage?.emailBytes ? (
                  <div className="storage-row storage-row--muted">
                    <span className="storage-row__name">Gmail et Photos</span>
                    <span className="storage-row__bar" />
                    <span className="storage-row__size tnum">
                      {formatBytes(usage.emailBytes)}
                    </span>
                    <span className="storage-row__count">annoncé par Google</span>
                  </div>
                ) : null}

                {unknownShare > 0 ? (
                  <div className="storage-row storage-row--muted">
                    <span className="storage-row__name">Documents Google natifs et autres</span>
                    <span className="storage-row__bar" />
                    <span className="storage-row__size tnum">
                      {formatBytes(unknownShare)}
                    </span>
                    <span className="storage-row__count">
                      {usage?.emailBytes ? 'reste du quota' : 'non détaillé'}
                    </span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <p className="storage-note">
            {incomplete
              ? 'Compte volumineux : certaines sommes sont plafonnées. Le signe ≥ indique un minimum.'
              : 'Les tailles proviennent des métadonnées Drive, limitées à vos propres fichiers : un fichier partagé par quelqu’un d’autre ne consomme pas votre quota. Les documents Google natifs (Docs, Sheets, Slides) n’exposent pas de taille : ils apparaissent dans le reste du quota.'}
          </p>
          </>
          ) : (
            // MEGA ne publie pas la nature des fichiers : afficher des lignes à
            // 0 o laisserait croire que le compte est vide. On s'arrête au
            // quota, qui est réel, et on le dit.
            <div className="panel" style={{ marginTop: 18 }}>
              <div className="empty">
                <span className="empty__icon">
                  <HardDrive size={18} />
                </span>
                <p className="empty__title">Le quota, sans détail par type</p>
                <p className="empty__text">
                  {PROVIDERS[account.provider].name} ne communique pas la nature des
                  fichiers stockés : seuls l’espace utilisé et le total sont connus,
                  et ils viennent du compte lui-même. Le détail par type est mesuré
                  pour les comptes Google Drive.
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
