import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  Cable,
  Check,
  CircleSlash,
  CloudUpload,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  PROVIDERS,
  PROVIDER_LIST,
  type Account,
  type AccountStatus,
  type ProviderId,
} from '../data/catalog';
import { KeyRound, LockKeyhole, Unplug } from 'lucide-react';
import { defaultDraft, useStore, type Route } from '../store';
import { GoogleConnectDialog, GoogleSetupDialog } from '../components/GoogleDialogs';
import { useGoogleAccountSync, useGoogleClientStatus } from '../hooks/useGoogle';
import { getBridge, isDesktop } from '../lib/bridge';
import { isRealAccount, realAccountId } from '../lib/google';
import { formatBytes, formatDate, formatDecimal, normalize, percent } from '../lib/format';
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

export function Clouds({ provider, onNavigate, onOpenAccount }: CloudsProps) {
  const { state, dispatch } = useStore();
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | AccountStatus>('all');
  const [dialog, setDialog] = useState<
    | { kind: 'add' }
    | { kind: 'googleSetup' }
    | { kind: 'googleConnect' }
    | { kind: 'rename'; account: Account }
    | { kind: 'delete'; account: Account }
    | null
  >(null);

  const googleClient = useGoogleClientStatus();
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
  const demoAccounts = accounts.filter((account) => !isRealAccount(account));
  const otherProviders = PROVIDER_LIST.filter((item) => item.id !== provider);

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
            {provider === 'gdrive' && realAccounts.length
              ? `${formatDecimal(realAccounts.length)} compte${
                  realAccounts.length > 1 ? 's' : ''
                } Google réel${realAccounts.length > 1 ? 's' : ''} en lecture seule${
                  demoAccounts.length
                    ? ` · ${formatDecimal(demoAccounts.length)} compte${
                        demoAccounts.length > 1 ? 's' : ''
                      } de démonstration`
                    : ''
                }.`
              : `${def.tagline} — ${formatDecimal(accounts.length)} compte${
                  accounts.length > 1 ? 's' : ''
                } de démonstration. Chaque compte possède sa propre arborescence fictive.`}
          </p>
        </div>
        <div className="page-head__actions">
          {provider === 'gdrive' && desktop ? (
            <>
              <button
                type="button"
                className="btn btn--ghost"
                title="Ajouter un compte de démonstration fictif"
                onClick={() => setDialog({ kind: 'add' })}
              >
                <Plus size={13} />
                Démonstration
              </button>
              {googleClient.status?.configured ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    title="Modifier l’identifiant client OAuth"
                    onClick={() => setDialog({ kind: 'googleSetup' })}
                  >
                    <KeyRound size={13} />
                    Configurer
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => setDialog({ kind: 'googleConnect' })}
                  >
                    <Plus size={14} strokeWidth={2.4} />
                    Connecter un compte Google
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setDialog({ kind: 'googleSetup' })}
                >
                  <KeyRound size={13} />
                  Configurer Google Drive
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setDialog({ kind: 'add' })}
            >
              <Plus size={14} strokeWidth={2.4} />
              Ajouter un compte
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
              {formatDecimal(accounts.length)} comptes · {formatDecimal(totals.connected)}{' '}
              connectés
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
            <p className="empty__title">Aucun compte ne correspond</p>
            <p className="empty__text">
              Modifiez la recherche ou le filtre d’état, ou ajoutez un nouveau compte de
              démonstration.
            </p>
            <div className="empty__actions">
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
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => setDialog({ kind: 'add' })}
                title="Ajouter un compte de démonstration"
              >
                <Plus size={13} />
                Démonstration
              </button>
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
                    {isRealAccount(account) ? (
                      <span className="badge badge--live" title="Compte Google connecté — accès en lecture seule">
                        <LockKeyhole size={9} />
                        Réel
                      </span>
                    ) : null}
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
                      <b>{formatBytes(account.usedBytes)}</b> / {formatBytes(account.quotaBytes)}
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
                  {account.status === 'expired' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title={
                        isRealAccount(account)
                          ? 'Autorisation expirée — se reconnecter'
                          : 'Rafraîchir la session (simulation)'
                      }
                      onClick={() => {
                        if (isRealAccount(account)) {
                          setDialog(
                            googleClient.status?.configured
                              ? { kind: 'googleConnect' }
                              : { kind: 'googleSetup' },
                          );
                          return;
                        }
                        dispatch({
                          type: 'account/patch',
                          id: account.id,
                          status: 'connected',
                        });
                        toast.push(`Session rétablie pour ${account.name}`, 'ok');
                      }}
                    >
                      <Cable size={14} />
                    </button>
                  ) : isRealAccount(account) ? (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Rafraîchir le quota depuis Google"
                      onClick={() => {
                        const googleId = realAccountId(account);
                        if (!googleId) return;
                        void getBridge()
                          ?.google.refresh(googleId)
                          .then((info) => {
                            if (!info) return;
                            dispatch({
                              type: 'account/patch',
                              id: account.id,
                              status: info.status,
                            });
                            toast.push('Quota Google actualisé', 'ok');
                          })
                          .catch((cause: Error) =>
                            toast.push(cause.message || 'Rafraîchissement impossible', 'error'),
                          );
                      }}
                    >
                      <RefreshCw size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-btn"
                      title="Resynchroniser (simulation)"
                      onClick={() => toast.push(`Synchronisation simulée de ${account.name}`)}
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
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
                    title={
                      isRealAccount(account)
                        ? `Déconnecter ${account.name}`
                        : state.settings.confirmDelete
                          ? `Supprimer ${account.name}`
                          : `Supprimer ${account.name} immédiatement`
                    }
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
                      dispatch({ type: 'account/remove', id: account.id });
                      toast.push(
                        isRealAccount(account)
                          ? `Accès Google révoqué pour ${account.name}`
                          : `Compte ${account.name} supprimé`,
                        'warn',
                      );
                    }}
                  >
                    {isRealAccount(account) ? <Unplug size={14} /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="section" style={{ marginTop: 20 }}>
        <div className="section-head">
          <h2 className="section-title">Autres fournisseurs</h2>
        </div>
        <div className="panel">
          {otherProviders.map((item) => {
            const count = state.accounts.filter((a) => a.provider === item.id).length;
            const used = state.accounts
              .filter((a) => a.provider === item.id)
              .reduce((sum, a) => sum + a.usedBytes, 0);
            return (
              <button
                key={item.id}
                type="button"
                className="list-row list-row--button"
                onClick={() => onNavigate({ name: 'clouds', provider: item.id })}
              >
                <ProviderMark provider={item.id} />
                <span className="list-row__main">
                  <span className="list-row__title">{item.name}</span>
                  <span className="list-row__meta">
                    {formatDecimal(count)} comptes
                    <span className="dot-sep" />
                    {formatBytes(used)} utilisés
                  </span>
                </span>
                <ArrowUpRight size={14} className="muted" />
              </button>
            );
          })}
        </div>
      </div>

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
          <>
            <LockKeyhole size={11} /> Les comptes marqués « Réel » sont connectés à Google
            Drive en lecture seule. Cet écran n’affiche que des métadonnées : aucun jeton ne
            circule dans l’interface.
          </>
        ) : (
          <>
            <CircleSlash size={11} /> Aucune connexion réelle — les ajouts et suppressions
            affectent uniquement le stockage local de démonstration.
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

      {dialog?.kind === 'googleConnect' ? (
        <GoogleConnectDialog
          onClose={() => setDialog(null)}
          onConnected={(info) => {
            applyGoogleAccount(info);
            setDialog(null);
            toast.push(`Compte ${info.email} connecté`, 'ok');
          }}
        />
      ) : null}

      {dialog?.kind === 'add' ? (
        <AddAccountDialog
          provider={provider}
          onClose={() => setDialog(null)}
          onConfirm={(name, email) => {
            dispatch({ type: 'account/add', provider, name, email });
            setDialog(null);
            toast.push(`Compte ${name} ajouté à ${def.name}`, 'ok');
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
            dispatch({ type: 'account/remove', id: dialog.account.id });
            setDialog(null);
            toast.push(`Compte ${dialog.account.name} supprimé`, 'warn');
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AddAccountDialog({
  provider,
  onClose,
  onConfirm,
}: {
  provider: ProviderId;
  onClose: () => void;
  onConfirm: (name: string, email: string) => void;
}) {
  const { state } = useStore();
  const draft = defaultDraft(provider, state.accounts);
  const [name, setName] = useState(draft.name);
  const [email, setEmail] = useState(draft.email);
  const [authorized, setAuthorized] = useState(true);

  const nameConflict = state.accounts.some(
    (account) => account.provider === provider && normalize(account.name) === normalize(name.trim()),
  );
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSubmit = name.trim().length > 0 && emailValid && !nameConflict && authorized;

  return (
    <Modal
      title={`Ajouter un compte ${PROVIDERS[provider].name}`}
      description="Simulation locale : le compte est créé immédiatement avec son propre catalogue fictif."
      icon={<CloudUpload size={16} />}
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
            onClick={() => onConfirm(name.trim(), email.trim())}
          >
            <Check size={14} strokeWidth={2.6} />
            Ajouter le compte
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="account-name">
          Nom personnalisé
        </label>
        <input
          id="account-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="MEGA12"
          autoComplete="off"
          spellCheck={false}
        />
        {nameConflict ? (
          <span className="field__hint" style={{ color: 'var(--danger)' }}>
            Ce nom est déjà utilisé pour ce fournisseur.
          </span>
        ) : (
          <span className="field__hint">
            Sert d’identifiant dans la barre latérale et l’explorateur.
          </span>
        )}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="account-email">
          Adresse fictive
        </label>
        <input
          id="account-email"
          className="input"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={`compte@${PROVIDERS[provider].domain}`}
          autoComplete="off"
          spellCheck={false}
        />
        {!emailValid && email.length > 0 ? (
          <span className="field__hint" style={{ color: 'var(--danger)' }}>
            Format d’adresse invalide.
          </span>
        ) : null}
      </div>
      <div className="callout">
        <RefreshCw size={13} />
        <span>
          Quota simulé : {formatBytes(PROVIDERS[provider].quota)}.{' '}
          {formatDate(new Date().toISOString())} — aucune authentification n’est effectuée.
        </span>
      </div>
      <label
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 9,
          fontSize: 11.5,
          color: 'var(--text-3)',
          cursor: 'pointer',
          lineHeight: 1.45,
        }}
      >
        <input
          type="checkbox"
          checked={authorized}
          onChange={(event) => setAuthorized(event.target.checked)}
          style={{ marginTop: 2, accentColor: 'var(--accent)' }}
        />
        Je comprends que ce compte est fictif et reste stocké sur cet ordinateur.
      </label>
    </Modal>
  );
}

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
      title={`Supprimer ${account.name} ?`}
      description="Le compte de démonstration et ses favoris associés seront retirés de l’application."
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
            <Trash2 size={13} />
            Supprimer définitivement
          </button>
        </>
      }
    >
      <div className="callout callout--warn">
        <CircleSlash size={13} />
        <span>
          {formatBytes(account.usedBytes)} de fichiers fictifs et les entrées favorites de
          ce compte seront oubliés.
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
        <div className="callout callout--warn">
          <CircleSlash size={13} />
          <span>Le dernier compte ne peut pas être supprimé.</span>
        </div>
      ) : null}
    </Modal>
  );
}
