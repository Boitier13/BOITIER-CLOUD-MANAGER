import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Cable,
  CircleSlash,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { PROVIDERS, type Account, type AccountStatus, type ProviderId } from '../data/catalog';
import { KeyRound, LockKeyhole, TriangleAlert, Unplug } from 'lucide-react';
import { useStore, type Route } from '../store';
import { GoogleConnectDialog, GoogleSetupDialog } from '../components/GoogleDialogs';
import { MegaConnectDialog } from '../components/MegaDialogs';
import { ShadowDialog } from '../components/ShadowDialog';
import { TeraBoxDialog } from '../components/TeraBoxDialog';
import { useTeraBoxSync } from '../hooks/useTeraBox';
import { useShadowAccountSync } from '../hooks/useShadow';
import { useMegaAccountSync } from '../hooks/useMega';
import { useGoogleAccountSync, useGoogleClientStatus } from '../hooks/useGoogle';
import { getBridge, isDesktop } from '../lib/bridge';
import { isRealAccount, realAccountId } from '../lib/google';
import { looksLikeGmailVariant } from '../lib/accounts';
import { formatBytes, formatDecimal, normalize, percent } from '../lib/format';
import { Meter, ProviderMark } from '../components/visuals';
import { Modal } from '../components/Modal';
import { useToast } from '../components/toast';

interface CloudsProps {
  provider: ProviderId;
  onNavigate: (route: Route) => void;
  onOpenAccount: (accountId: string) => void;
}

const STATUS_META: Record<
  AccountStatus,
  { label: string; className: string; dot: string }
> = {
  connected: { label: 'Connecté', className: 'badge--ok', dot: 'dot--ok' },
  syncing: { label: 'Synchronisation', className: 'badge--warn', dot: 'dot--warn' },
  expired: { label: 'Session expirée', className: 'badge--danger', dot: 'dot--danger' },
};

/**
 * Déconnecte un compte : le disque **et** la liste, au même moment.
 *
 * Pour Google, l'appel révoque le jeton et retire l'entrée du coffre — sans lui,
 * le compte reviendrait à la synchronisation suivante. Pour MEGA, il ferme la
 * session et efface la session chiffrée.
 *
 * C'est le seul chemin de suppression : la synchronisation, elle, n'enlève
 * jamais rien (voir `lib/accountSync.ts`).
 */
function useDisconnect(): (account: Account) => Promise<boolean> {
  const { dispatch } = useStore();
  const toast = useToast();
  return useCallback(
    async (account: Account) => {
      const pont = getBridge();
      if (account.provider === 'terabox') {
        try {
          if (!pont?.terabox || !account.teraboxId) throw new Error('Coffre TeraBox indisponible.');
          await pont.terabox.disconnect(account.teraboxId);
        } catch (cause) {
          toast.push((cause as Error).message || 'Déconnexion TeraBox impossible', 'error');
          return false;
        }
      } else if (account.provider === 'shadow') {
        try {
          if (!pont?.shadow || !account.shadowId) throw new Error('Coffre Shadow Drive indisponible.');
          await pont.shadow.disconnect(account.shadowId);
        } catch (cause) {
          toast.push((cause as Error).message || 'Déconnexion Shadow Drive impossible', 'error');
          return false;
        }
      } else if (account.provider === 'mega') {
        void pont?.mega?.disconnect(account.megaId ?? '').catch(() => undefined);
      } else if (account.provider === 'gdrive') {
        const reel = realAccountId(account);
        if (reel) void pont?.google.disconnect(reel).catch(() => undefined);
      }
      dispatch({ type: 'account/remove', id: account.id });
      return true;
    },
    [dispatch, toast],
  );
}

export function Clouds({ provider, onNavigate, onOpenAccount }: CloudsProps) {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const deconnecter = useDisconnect();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | AccountStatus>('all');
  const [dialog, setDialog] = useState<
    | { kind: 'megaConnect'; reconnect?: Account }
    | { kind: 'shadowConnect'; reconnect?: Account }
    | { kind: 'teraboxConnect'; reconnect?: Account }
    | { kind: 'googleSetup' }
    | { kind: 'googleConnect'; reconnect?: boolean }
    | { kind: 'rename'; account: Account }
    | { kind: 'delete'; account: Account }
    | null
  >(null);

  const googleClient = useGoogleClientStatus();
  // Comptes MEGA déjà connus du processus principal (sessions restaurées).
  useMegaAccountSync();
  useShadowAccountSync();
  useTeraBoxSync();
  const applyGoogleAccount = useGoogleAccountSync();
  const desktop = isDesktop();

  // Ouverture directe du dialogue demandé depuis un autre écran.
  useEffect(() => {
    if (provider !== 'gdrive' || !desktop) return;
    const pending = window.sessionStorage.getItem('boitier:google-connect');
    if (!pending) return;
    window.sessionStorage.removeItem('boitier:google-connect');
    setDialog(
      googleClient.status?.configured ? { kind: 'googleConnect' } : { kind: 'googleSetup' },
    );
  }, [provider, desktop, googleClient.status?.configured]);

  const def = PROVIDERS[provider];
  const accounts = state.accounts.filter((account) => account.provider === provider);
  const realAccounts = accounts.filter(isRealAccount);

  // Adresses qui ne désignent pas un compte distinct : variantes `+` et à
  // points d'un compte Gmail. On les montre au lieu de laisser croire à des
  // comptes séparés.
  const gmailAliasAccounts = realAccounts.filter((account) =>
    account.provider === 'gdrive' && looksLikeGmailVariant(account.email),
  );

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    return accounts.filter((account) => {
      if (statusFilter !== 'all' && account.status !== statusFilter) return false;
      if (!q) return true;
      return (
        normalize(account.name).includes(q) ||
        normalize(account.email).includes(q)
      );
    });
  }, [accounts, query, statusFilter]);

  const totals = useMemo(() => {
    const used = accounts.reduce((sum, account) => sum + account.usedBytes, 0);
    const quota = accounts.reduce((sum, account) => sum + account.quotaBytes, 0);
    const connected = accounts.filter((a) => a.status === 'connected').length;
    return { used, quota, connected, ratio: quota ? used / quota : 0 };
  }, [accounts]);

  const initials = (name: string) =>
    name
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Clouds</div>
          <h1 className="page-title">{def.name}</h1>
          <p className="page-subtitle">
            {realAccounts.length
              ? provider === 'terabox'
                ? `${formatDecimal(realAccounts.length)} compte(s) TeraBox connecté(s) — accès Web provisoire.`
                : provider === 'shadow'
                ? `${formatDecimal(realAccounts.length)} compte(s) Shadow Drive connecté(s) — lecture et téléchargement.`
                : provider === 'mega'
                ? `${formatDecimal(realAccounts.length)} compte${
                    realAccounts.length > 1 ? 's' : ''
                  } MEGA connecté${realAccounts.length > 1 ? 's' : ''} — lecture, téléchargement et envoi, ` +
                  'sans suppression ni déplacement.'
                : `${formatDecimal(realAccounts.length)} compte${
                    realAccounts.length > 1 ? 's' : ''
                  } Google connecté${realAccounts.length > 1 ? 's' : ''} en lecture seule — ` +
                  'aucune modification n’est possible depuis cette application.'
              : provider === 'terabox'
                ? 'Aucun compte connecté. Connectez TeraBox avec votre session Web.'
                : provider === 'shadow'
                ? 'Aucun compte connecté. Connectez Shadow Drive avec un jeton WebDAV dédié.'
                : provider === 'mega'
                ? 'Aucun compte connecté. Vos fichiers restent chez MEGA : le mot de passe sert à ouvrir la session et n’est jamais enregistré.'
                : 'Aucun compte connecté. Vos fichiers restent chez Google : l’application ne lit que ce que vous l’autorisez.'}
          </p>
        </div>
        <div className="page-head__actions">
          {desktop ? (
            <>
              {provider === 'gdrive' && googleClient.status?.configured ? (
                <button
                  type="button"
                  className="btn btn--ghost"
                  title="Modifier l’identifiant client OAuth"
                  onClick={() => setDialog({ kind: 'googleSetup' })}
                >
                  <KeyRound size={13} />
                  Configurer
                </button>
              ) : null}
              {provider === 'terabox' ? (
                <button type="button" className="btn btn--primary" onClick={() => setDialog({ kind: 'teraboxConnect' })}><Plus size={14} /> Connecter TeraBox</button>
              ) : provider === 'shadow' ? (
                <button type="button" className="btn btn--primary" onClick={() => setDialog({ kind: 'shadowConnect' })}>
                  <Plus size={14} strokeWidth={2.4} /> Connecter Shadow Drive
                </button>
              ) : provider === 'mega' ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setDialog({ kind: 'megaConnect' })}
                >
                  <Plus size={14} strokeWidth={2.4} />
                  Connecter un compte MEGA
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() =>
                    setDialog(
                      googleClient.status?.configured
                        ? { kind: 'googleConnect' }
                        : { kind: 'googleSetup' },
                    )
                  }
                >
                  <Plus size={14} strokeWidth={2.4} />
                  {googleClient.status?.configured
                    ? 'Connecter un compte Google'
                    : 'Configurer Google Drive'}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => onNavigate({ name: 'settings' })}
              title="La connexion Google nécessite la version Windows"
            >
              <KeyRound size={13} />
              Connexion disponible sous Windows
            </button>
          )}
        </div>
      </div>

      <div className="provider-hero" style={{ ['--brand' as string]: def.brand }}>
        <div className="provider-hero__id">
          <ProviderMark provider={provider} size="lg" />
          <div>
            <div className="provider-hero__name">{def.name}</div>
            <div className="provider-hero__tag">
              {formatDecimal(accounts.length)} {accounts.length > 1 ? 'comptes' : 'compte'} ·{' '}
              {formatDecimal(totals.connected)}{' '}
              {totals.connected > 1 ? 'connectés' : 'connecté'}
            </div>
          </div>
        </div>
        <div className="provider-hero__stats">
          <div className="stat-block">
            <span className="stat-block__label">Espace utilisé</span>
            <span className="stat-block__value tnum">
              {formatBytes(totals.used)}
              <small>sur {formatBytes(totals.quota)}</small>
            </span>
          </div>
          <div className="stat-block">
            <span className="stat-block__label">Occupation</span>
            <span className="stat-block__value tnum">{percent(totals.ratio)}</span>
          </div>
          <div className="stat-block" style={{ width: 128 }}>
            <span className="stat-block__label">Quota global</span>
            <Meter value={totals.ratio} tone={def.brand} />
          </div>
        </div>
      </div>

      <div className="filter-bar">
        <div className="segmented">
          {(
            [
              ['all', 'Tous', accounts.length],
              ['connected', 'Connectés', accounts.filter((a) => a.status === 'connected').length],
              ['syncing', 'Synchronisation', accounts.filter((a) => a.status === 'syncing').length],
              ['expired', 'Expirés', accounts.filter((a) => a.status === 'expired').length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              className={`segmented__item${statusFilter === value ? ' is-active' : ''}`}
              onClick={() => setStatusFilter(value)}
            >
              {label}
              <span className="segmented__count tnum">{formatDecimal(count)}</span>
            </button>
          ))}
        </div>
        <div className="filter-bar__spacer" />
        <div className="search" style={{ width: 220 }}>
          <Search size={13} />
          <input
            className="input"
            placeholder="Rechercher un compte…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Rechercher un compte"
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

      <div className="panel">
        {filtered.length === 0 ? (
          <div className="empty">
            <span className="empty__icon">
              <Users size={18} />
            </span>
            <p className="empty__title">
              {accounts.length === 0 ? 'Aucun compte connecté' : 'Aucun compte ne correspond'}
            </p>
            <p className="empty__text">
              {accounts.length === 0
                ? desktop
                  ? `Connectez un compte ${def.name} pour explorer vos fichiers.`
                  : 'La connexion est disponible dans l’application Windows.'
                : 'Modifiez la recherche ou le filtre d’état pour retrouver un compte.'}
            </p>
            <div className="empty__actions">
              {accounts.length === 0 ? (
                desktop ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={() => provider === 'terabox' ? setDialog({ kind: 'teraboxConnect' }) : provider === 'shadow' ? setDialog({ kind: 'shadowConnect' }) : provider === 'mega' ? setDialog({ kind: 'megaConnect' }) : setDialog(googleClient.status?.configured ? { kind: 'googleConnect' } : { kind: 'googleSetup' })}
                  >
                    <Plus size={13} />
                    Connecter {def.name}
                  </button>
                ) : null
              ) : (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    setQuery('');
                    setStatusFilter('all');
                  }}
                >
                  Réinitialiser les filtres
                </button>
              )}
            </div>
          </div>
        ) : (
          filtered.map((account) => {
            const meta = STATUS_META[account.status];
            const ratio = account.usedBytes / Math.max(account.quotaBytes, 1);
            return (
              <div className="account-row" key={account.id}>
                <span
                  className="account-row__avatar"
                  style={{ ['--brand' as string]: def.brand }}
                >
                  {account.avatarUrl ? (
                    <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    initials(account.name)
                  )}
                </span>
                <div className="account-row__id">
                  <span className="account-row__name">
                    <span>{account.name}</span>
                    <span
                      className="badge badge--live"
                      title={
                        provider === 'mega'
                          ? 'Compte MEGA connecté — lecture, téléchargement et envoi, sans suppression'
                          : `Compte ${def.name} connecté — accès en lecture seule`
                      }
                    >
                      <LockKeyhole size={9} />
                      {provider === 'mega' ? 'Lecture et envoi' : 'Lecture seule'}
                    </span>
                  </span>
                  <span className="account-row__email">{account.email}</span>
                </div>
                <div className="account-row__status">
                  <span className={`badge ${meta.className}`}>
                    <span className={`dot ${meta.dot}`} />
                    {meta.label}
                  </span>
                </div>
                <div className="account-row__usage">
                  <div className="account-row__usage-top">
                    <span>
                      {account.quotaBytes > 0 ? <><b>{formatBytes(account.usedBytes)}</b> / {formatBytes(account.quotaBytes)}</> : 'Quota indisponible'}
                    </span>
                    <span>{percent(ratio)}</span>
                  </div>
                  <Meter value={ratio} />
                </div>
                <div className="account-row__actions">
                  <button
                    type="button"
                    className="account-row__open"
                    onClick={() => onOpenAccount(account.id)}
                    title={`Ouvrir ${account.name}`}
                  >
                    Ouvrir
                    <ArrowUpRight size={12} />
                  </button>
                  {account.status === 'expired' ? null : (
                    <button
                      type="button"
                      className="icon-btn"
                      title={`Rafraîchir le quota depuis ${def.name}`}
                      onClick={() => {
                        const compteId = realAccountId(account);
                        if (!compteId) return;
                        // Chaque fournisseur a sa mesure : la ligne MEGA
                        // interrogeait Google avec un identifiant MEGA.
                        const pont = getBridge();
                        if (!pont) return;
                        const requete =
                          provider === 'terabox'
                            ? pont.terabox?.usage(compteId).then((mesure) => mesure ? { status: 'connected' as const, ...mesure } : null)
                            : provider === 'shadow'
                            ? pont.shadow?.usage(compteId).then((mesure) => mesure ? { status: 'connected' as const, ...mesure } : null)
                            : provider === 'mega'
                            ? pont.mega?.usage(compteId).then((mesure) =>
                                mesure
                                  ? {
                                      status: 'connected' as const,
                                      usedBytes: mesure.usedBytes,
                                      quotaBytes: mesure.quotaBytes,
                                    }
                                  : null,
                              )
                            : pont.google.refresh(compteId);
                        void Promise.resolve(requete)
                          .then((info) => {
                            if (!info) return;
                            // Les chiffres relus doivent atteindre l'écran : sans
                            // eux, le message « quota actualisé » s'affichait
                            // devant des valeurs inchangées.
                            dispatch({
                              type: 'account/patch',
                              id: account.id,
                              status: info.status,
                              usedBytes: info.usedBytes,
                              quotaBytes: info.quotaBytes,
                            });
                            toast.push(`Quota ${def.name} actualisé`, 'ok');
                          })
                          .catch((cause: Error) =>
                            toast.push(cause.message || 'Rafraîchissement impossible', 'error'),
                          );
                      }}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {/* Renouveler l'autorisation sans retirer le compte : le nom
                      choisi, l'ordre et les favoris restent en place. */}
                  <button
                    type="button"
                    className="icon-btn"
                    title={
                      provider === 'mega'
                        ? `Reconnecter ${account.name} — rouvrir la session MEGA`
                        : `Reconnecter ${account.name} — renouveler l’autorisation ${def.name}`
                    }
                    aria-label={`Reconnecter ${account.name}`}
                    onClick={() =>
                      provider === 'terabox'
                        ? setDialog({ kind: 'teraboxConnect', reconnect: account })
                        : provider === 'shadow'
                        ? setDialog({ kind: 'shadowConnect', reconnect: account })
                        : provider === 'mega'
                        ? setDialog({ kind: 'megaConnect', reconnect: account })
                        : setDialog(
                            googleClient.status?.configured
                              ? { kind: 'googleConnect', reconnect: true }
                              : { kind: 'googleSetup' },
                          )
                    }
                  >
                    <Cable size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Renommer ${account.name}`}
                    onClick={() => setDialog({ kind: 'rename', account })}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Déconnecter ${account.name}`}
                    onClick={() => {
                      if (state.settings.confirmDelete) {
                        setDialog({ kind: 'delete', account });
                        return;
                      }
                      // Suppression directe (confirmation désactivée dans les paramètres).
                      if (state.explorer.accountId === account.id) {
                        const fallback = state.accounts.find((a) => a.id !== account.id);
                        if (fallback) {
                          dispatch({
                            type: 'explorer/chooseAccount',
                            accountId: fallback.id,
                          });
                        }
                      }
                      void deconnecter(account).then((ok) => { if (ok) toast.push(`Compte ${account.name} déconnecté`, 'warn'); });
                    }}
                  >
                    <Unplug size={14} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {gmailAliasAccounts.length > 0 ? (
        <div className="callout" style={{ marginTop: 16 }}>
          <TriangleAlert size={13} style={{ flex: 'none', marginTop: 1 }} />
          <span>
            {formatDecimal(gmailAliasAccounts.length)}{' '}
            {gmailAliasAccounts.length > 1 ? 'comptes utilisent' : 'compte utilise'} une
            variante d’adresse Gmail (
            {gmailAliasAccounts
              .slice(0, 3)
              .map((account) => account.email)
              .join(', ')}
            {gmailAliasAccounts.length > 3 ? '…' : ''}). Une adresse avec « + » ou des
            points désigne la <b>même boîte</b> que l’adresse principale, donc le même
            Drive : Google ne la comptera pas comme un second compte.
          </span>
        </div>
      ) : null}

      <p
        style={{
          marginTop: 16,
          fontSize: 10.5,
          color: 'var(--text-4)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {realAccounts.length ? (
          provider === 'mega' ? (
            <>
              <LockKeyhole size={11} /> Aucune suppression ni déplacement depuis cette
              application. Le mot de passe MEGA n’est jamais conservé : seule la session est
              enregistrée, chiffrée par Windows.
            </>
          ) : (
            <>
              <LockKeyhole size={11} /> Accès en lecture seule : aucun fichier ne peut être
              supprimé, déplacé ni modifié depuis cette application. {provider === 'shadow' ? 'Le jeton WebDAV est conservé chiffré par Windows.' : provider === 'terabox' ? 'La session Web provisoire est chiffrée par Windows.' : 'Le jeton Google ne circule pas dans l’interface.'}
            </>
          )
        ) : (
          <>
            <CircleSlash size={11} /> Aucun compte connecté : l’application n’a accès à
            aucun de vos fichiers.
          </>
        )}
      </p>

      {dialog?.kind === 'googleSetup' ? (
        <GoogleSetupDialog
          status={googleClient.status}
          onClose={() => setDialog(null)}
          onSaved={async (status) => {
            await googleClient.reload();
            toast.push('Client OAuth Google enregistré', 'ok');
            setDialog(status.configured ? { kind: 'googleConnect' } : null);
          }}
        />
      ) : null}

      {dialog?.kind === 'teraboxConnect' ? (
        <TeraBoxDialog reconnect={dialog.reconnect} onClose={() => setDialog(null)} onConnected={() => { setDialog(null); toast.push('Compte TeraBox connecté', 'ok'); }} />
      ) : null}

      {dialog?.kind === 'shadowConnect' ? (
        <ShadowDialog reconnect={dialog.reconnect} onClose={() => setDialog(null)} onConnected={() => { setDialog(null); toast.push('Compte Shadow Drive connecté', 'ok'); }} />
      ) : null}

      {dialog?.kind === 'megaConnect' ? (
        <MegaConnectDialog
          reconnect={
            dialog.reconnect
              ? { email: dialog.reconnect.email, name: dialog.reconnect.name }
              : undefined
          }
          onClose={() => setDialog(null)}
          onConnected={(nom) => {
            const reconnecte = Boolean(dialog.reconnect);
            setDialog(null);
            toast.push(
              reconnecte
                ? `Compte MEGA ${nom} reconnecté — session rouverte`
                : `Compte MEGA ${nom} connecté`,
              'ok',
            );
          }}
        />
      ) : null}

      {dialog?.kind === 'googleConnect' ? (
        <GoogleConnectDialog
          reconnecting={dialog.reconnect === true}
          onClose={() => setDialog(null)}
          onConnected={(info) => {
            applyGoogleAccount(info);
            setDialog(null);
            // Google renvoie toujours l'adresse principale : si le compte
            // existait déjà, on le dit au lieu de laisser croire à un ajout.
            toast.push(
              info.alreadyConnected
                ? `${info.email} était déjà connecté — informations mises à jour`
                : `Compte ${info.email} connecté`,
              'ok',
            );
          }}
        />
      ) : null}

      {dialog?.kind === 'rename' ? (
        <RenameDialog
          account={dialog.account}
          onClose={() => setDialog(null)}
          onConfirm={(name) => {
            dispatch({ type: 'account/patch', id: dialog.account.id, name });
            setDialog(null);
            toast.push('Compte renommé', 'ok');
          }}
        />
      ) : null}

      {dialog?.kind === 'delete' ? (
        <DeleteDialog
          account={dialog.account}
          onClose={() => setDialog(null)}
          onConfirm={(reassign) => {
            if (reassign) dispatch({ type: 'explorer/chooseAccount', accountId: reassign });
            const compte = dialog.account;
            setDialog(null);
            void deconnecter(compte).then((ok) => { if (ok) toast.push(`Compte ${compte.name} supprimé`, 'warn'); });
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RenameDialog({
  account,
  onClose,
  onConfirm,
}: {
  account: Account;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(account.name);
  const canSubmit = name.trim().length > 0 && name.trim() !== account.name;

  return (
    <Modal
      title="Renommer le compte"
      description={`${account.email} — le nom apparaît partout dans l’application.`}
      icon={<Pencil size={15} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={() => onConfirm(name.trim())}
          >
            Enregistrer
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="rename-input">
          Nouveau nom
        </label>
        <input
          id="rename-input"
          className="input"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) onConfirm(name.trim());
          }}
        />
        <span className="field__hint">
          Les fichiers restent attachés à ce compte et à son emplacement actuel.
        </span>
      </div>
    </Modal>
  );
}

function DeleteDialog({
  account,
  onClose,
  onConfirm,
}: {
  account: Account;
  onClose: () => void;
  onConfirm: (reassignTo?: string) => void;
}) {
  const { state } = useStore();
  const others = state.accounts.filter((item) => item.id !== account.id);
  const isCurrent = state.explorer.accountId === account.id;
  const [reassign, setReassign] = useState<string>(others[0]?.id ?? '');

  return (
    <Modal
      title={`Déconnecter ${account.name} ?`}
      description={`L’accès local à ${PROVIDERS[account.provider].name} sera supprimé. Vos fichiers restent intacts.`}
      icon={<Trash2 size={15} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => onConfirm(isCurrent && reassign ? reassign : undefined)}
          >
            <Unplug size={13} />
            Déconnecter
          </button>
        </>
      }
    >
      <div className="callout callout--warn">
        <CircleSlash size={13} />
        <span>
          {account.provider === 'gdrive'
            ? 'L’autorisation Google sera révoquée et le jeton chiffré effacé de cet ordinateur.'
            : account.provider === 'terabox'
              ? 'La session chiffrée sera effacée de cet ordinateur ; elle peut rester active chez TeraBox.'
              : account.provider === 'shadow'
              ? 'Le jeton chiffré sera effacé de cet ordinateur. Pour le révoquer aussi chez Shadow, supprimez-le dans votre compte Shadow Drive.'
              : 'La session MEGA sera déconnectée et ses données locales effacées.'} Vos fichiers ne sont pas touchés.
        </span>
      </div>
      {isCurrent && others.length > 0 ? (
        <div className="field">
          <label className="field__label" htmlFor="reassign">
            Compte à ouvrir ensuite
          </label>
          <select
            id="reassign"
            className="select"
            value={reassign}
            onChange={(event) => setReassign(event.target.value)}
            style={{ width: '100%' }}
          >
            {others.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — {PROVIDERS[item.provider].name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {others.length === 0 ? (
        <div className="callout">
          <CircleSlash size={13} />
          <span>
            C’est votre seul compte : l’application reviendra à un écran vide et proposera de
            vous reconnecter.
          </span>
        </div>
      ) : null}
    </Modal>
  );
}
