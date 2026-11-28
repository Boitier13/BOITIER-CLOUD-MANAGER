import { downloadAccount } from '../lib/cloud';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FolderOpen,
  Search as SearchIcon,
  SearchX,
  Users,
  X,
} from 'lucide-react';
import { PROVIDERS, type Account, type FileNode } from '../data/catalog';
import { useCatalog, useStore } from '../store';
import { accountMark, shortAddress } from '../lib/accounts';
import { isRealAccount, realAccountId } from '../lib/google';
import { ID_SEPARATOR, useSearchAcross } from '../lib/remote';
import { getBridge } from '../lib/bridge';
import { formatBytes, formatDecimal, formatRelative, normalize, plural } from '../lib/format';
import { downloadSubPath } from '../lib/organize';
import { createDownload } from '../lib/downloads';
import { TypeIcon } from '../components/visuals';
import { useToast } from '../components/toast';

/**
 * Recherche dans **un** compte ou dans **tous**.
 *
 * Google Drive ne sait pas chercher dans plusieurs comptes d'un seul appel :
 * chacun a son propre espace, son propre jeton. La recherche multi-comptes est
 * donc une somme de recherches, lancées en parallèle, dont les résultats sont
 * regroupés par compte — sinon on ne saurait plus de quel Drive vient un
 * fichier.
 *
 * Deux garde-fous d'usage :
 *   • la frappe est laissée tranquille 400 ms avant d'interroger (neuf comptes
 *     fois chaque lettre serait absurde) ;
 *   • aucun compte ne peut disparaître du résultat sans le dire : un compte qui
 *     refuse (autorisation expirée, quota) est listé avec sa raison.
 */

const DEBOUNCE_MS = 400;
const MIN_CHARS = 2;

type Row = {
  account: Account;
  node: FileNode;
  /** Chemin connu pour les comptes locaux ; vide pour Google (résolu à l'ouverture). */
  path: string[];
};

export function SearchPage() {
  const { state, dispatch } = useStore();
  const catalog = useCatalog();
  const toast = useToast();

  const [term, setTerm] = useState('');
  const [settled, setSettled] = useState('');
  const [scope, setScope] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Le champ est le propos de l'écran : le curseur y est déjà.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(term.trim()), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term]);

  const accounts = state.accounts;
  const scoped = useMemo(
    () => (scope === 'all' ? accounts : accounts.filter((account) => account.id === scope)),
    [accounts, scope],
  );
  /**
   * Identifiants **Google** des comptes à interroger.
   *
   * Un compte porte deux identifiants : celui de l'application
   * (`gdrive-real-…`, qui nomme le compte et ses favoris) et celui de Google,
   * seul connu du processus principal. Le catalogue distant est indexé par le
   * second : envoyer le premier produit « Compte Google inconnu ».
   */
  const realIds = useMemo(
    () =>
      scoped
        .map((account) => realAccountId(account))
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    [scoped],
  );

  const query = settled.length >= MIN_CHARS ? settled : '';
  const searching = query.length >= MIN_CHARS;
  const remoteStates = useSearchAcross(realIds, query, searching);

  /** Un compte sélectionné a pu être retiré : on revient sur « tous ». */
  useEffect(() => {
    if (scope !== 'all' && !accounts.some((account) => account.id === scope)) setScope('all');
  }, [accounts, scope]);

  const groups = useMemo(() => {
    if (!searching) return [] as { account: Account; rows: Row[] }[];
    const needle = normalize(query);
    return scoped
      .map((account) => {
        if (isRealAccount(account)) {
          const remoteId = realAccountId(account) ?? '';
          const nodes = remoteStates.get(remoteId)?.nodes ?? [];
          return {
            account,
            rows: nodes.map((node) => ({ account, node, path: [] as string[] })),
          };
        }
        // Compte de démonstration : arborescence locale, pas d'appel réseau.
        const rows = catalog.entries
          .filter((entry) => entry.accountId === account.id)
          .filter((entry) => normalize(entry.node.name).includes(needle))
          .slice(0, 50)
          .map((entry) => ({ account, node: entry.node, path: entry.path }));
        return { account, rows };
      })
      .filter((group) => group.rows.length > 0);
  }, [searching, query, scoped, remoteStates, catalog.entries]);

  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const pending = realIds.filter((id) => {
    const remote = remoteStates.get(id);
    return !remote || remote.status === 'loading';
  });
  const failed = realIds
    .map((id) => ({
      account: accounts.find((account) => realAccountId(account) === id),
      state: remoteStates.get(id),
    }))
    .filter((item) => item.state?.status === 'error');

  const download = (account: Account, node: FileNode) => {
    const bridge = getBridge();
    const googleId = isRealAccount(account) ? realAccountId(account) : undefined;
    if (!bridge || !googleId) {
      toast.push('Téléchargement indisponible dans le navigateur — utilisez la version Windows', 'warn');
      return;
    }
    const subPath = downloadSubPath(account.provider, node.type, state.settings.organizeDownloads);
    const item = createDownload({
      id: `${node.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: node.name,
      type: node.type,
      size: node.size,
      provider: account.provider,
      accountId: account.id,
      accountName: account.name,
      path: [node.name],
      seed: node.name.length * 7 + node.size,
      remoteId: node.id,
      remoteAccount: googleId,
      ...(subPath ? { subPath } : {}),
    });
    dispatch({ type: 'downloads/add', items: [item] });
    void downloadAccount({
        provider: account.provider,
        id: item.id,
        accountId: googleId,
        fileId: node.id,
        name: node.name,
        size: node.size,
        dir: state.settings.downloadFolder,
        ...(subPath ? { subPath } : {}),
      })
      .catch((cause: Error) => {
        dispatch({
          type: 'downloads/progress',
          updates: [
            {
              id: item.id,
              status: 'error',
              received: 0,
              size: node.size,
              speed: 0,
              message: cause.message || 'Téléchargement impossible',
            },
          ],
        });
        toast.push(cause.message || 'Téléchargement impossible', 'error');
      });
    toast.push('Téléchargement démarré', 'ok');
  };

  /**
   * Ouvre l'endroit où se trouve le résultat.
   *
   * Drive ne renvoie jamais le chemin d'un fichier, seulement l'identifiant de
   * son dossier parent : le processus principal remonte la chaîne et l'on ouvre
   * l'explorateur au bon niveau, avec le fil d'Ariane complet.
   */
  const reveal = async (row: Row) => {
    const bridge = getBridge();
    const googleId = isRealAccount(row.account) ? realAccountId(row.account) : undefined;
    if (!bridge) return;
    // MEGA ne fournit pas le chemin d'un fichier : on ouvre alors son dossier
    // d'affichage courant plutôt que de prétendre le localiser.
    if (row.account.provider === 'mega' || !googleId || (row.account.provider === 'gdrive' && !bridge.google.locate) || (row.account.provider === 'shadow' && !bridge.shadow?.locate) || (row.account.provider === 'terabox' && !bridge.terabox?.locate)) {
      dispatch({ type: 'explorer/open', accountId: row.account.id, path: row.path.slice(0, -1) });
      dispatch({ type: 'route', route: { name: 'files' } });
      return;
    }
    setBusyId(row.node.id);
    try {
      const trail = row.account.provider === 'terabox'
        ? await bridge.terabox!.locate(googleId, row.node.id)
        : row.account.provider === 'shadow'
        ? await bridge.shadow!.locate(googleId, row.node.id)
        : await bridge.google.locate!(googleId, row.node.id);
      const segments = trail.map((step) => `${step.name}${ID_SEPARATOR}${step.id}`);
      const target = row.node.children
        ? [...segments, `${row.node.name}${ID_SEPARATOR}${row.node.id}`]
        : segments;
      dispatch({ type: 'explorer/open', accountId: row.account.id, path: target });
      dispatch({ type: 'route', route: { name: 'files' } });
      const where = trail.map((step) => step.name).join(' / ');
      toast.push(where ? `Ouvert : ${where}` : 'Ouvert à la racine du compte');
    } catch (cause) {
      toast.push((cause as Error).message || 'Dossier introuvable', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const scopeLabel =
    scope === 'all'
      ? plural(accounts.length, 'compte')
      : `${accounts.find((a) => a.id === scope)?.name ?? '—'}`;

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Recherche</div>
          <h1 className="page-title">Chercher partout</h1>
          <p className="page-subtitle">
            Un nom de fichier ou de dossier, et l’application interroge {scopeLabel}. Chaque
            résultat indique son compte ; « Ouvrir le dossier » vous emmène à son emplacement réel.
          </p>
        </div>
        <div className="page-head__actions">
          <span className="badge">
            <Users size={11} />
            {formatDecimal(accounts.length)} comptes
          </span>
        </div>
      </div>

      <div className="explorer__filters">
        <div className="search">
          <SearchIcon size={13} />
          <input
            ref={inputRef}
            className="input"
            placeholder="Nom de fichier ou de dossier…"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            aria-label="Rechercher dans tous les comptes"
          />
          {term ? (
            <button
              type="button"
              className="search__clear"
              onClick={() => {
                setTerm('');
                setSettled('');
                inputRef.current?.focus();
              }}
              aria-label="Effacer la recherche"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <div className="segmented segmented--wrap" role="group" aria-label="Portée de la recherche">
          <button
            type="button"
            className={`segmented__item${scope === 'all' ? ' is-active' : ''}`}
            onClick={() => setScope('all')}
          >
            Tous les comptes
          </button>
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              className={`segmented__item${scope === account.id ? ' is-active' : ''}`}
              onClick={() => setScope(account.id)}
              title={`${account.name} · ${PROVIDERS[account.provider].name}`}
            >
              {account.name}
            </button>
          ))}
        </div>
      </div>

      <div className="filetable-wrap">
        {!searching ? (
          <div className="filetable-empty">
            <SearchIcon size={20} />
            <p className="filetable-empty__title">Saisissez au moins deux caractères</p>
            <p className="filetable-empty__text">
              La recherche porte sur le nom des fichiers et des dossiers, dans{' '}
              {scope === 'all' ? 'les comptes sélectionnés' : scopeLabel}. Tapez « facture »,
              « film » ou « CV », puis appuyez sur Entrée : rien n’est nécessaire.
            </p>
          </div>
        ) : total === 0 && pending.length === 0 && failed.length === 0 ? (
          <div className="filetable-empty">
            <SearchX size={20} />
            <p className="filetable-empty__title">Aucun fichier ne correspond</p>
            <p className="filetable-empty__text">
              Aucun nom ne contient « {query} » dans {scopeLabel}. Google ne cherche que sur le
              nom : essayez un mot plus court, ou une autre orthographe.
            </p>
          </div>
        ) : (
          <table className="filetable">
            <thead>
              <tr>
                <th>Nom</th>
                <th className="col-type">Compte</th>
                <th className="col-size">Taille</th>
                <th className="col-date">Date</th>
                <th className="col-star" />
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.account.id}>
                {scope === 'all' ? (
                  <tr className="filetable__group">
                    <td colSpan={5}>
                      <span className="filetable__group-mark">
                        {accountMark(group.account.email)}
                      </span>
                      <span className="filetable__group-name">{group.account.name}</span>
                      <span className="filetable__group-meta">
                        {plural(group.rows.length, 'résultat')} ·{' '}
                        {PROVIDERS[group.account.provider].name}
                      </span>
                    </td>
                  </tr>
                ) : null}
                {group.rows.map((row) => (
                  <tr
                    key={`${row.account.id}-${row.node.id}`}
                    className={row.node.children ? 'is-folder' : ''}
                    onClick={() => void reveal(row)}
                    title={
                      row.node.children
                        ? `Ouvrir ${row.node.name}`
                        : `Ouvrir le dossier contenant ${row.node.name}`
                    }
                  >
                    <td>
                      <span className="cell-name">
                        <TypeIcon type={row.node.type} size={13} />
                        <span className="cell-name__body">
                          <span className="cell-name__text">{row.node.name}</span>
                          <span className="cell-name__path">
                            {PROVIDERS[row.account.provider].name} · {row.account.name}
                            {row.path.length > 1
                              ? ` / ${row.path.slice(0, -1).join(' / ')}`
                              : ''}
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="col-type">
                      <span className="truncate" title={row.account.email}>
                        {shortAddress(row.account.email)}
                      </span>
                    </td>
                    <td className="col-size">
                      <span className="truncate">
                        {row.node.children
                          ? 'Dossier'
                          : row.node.size
                            ? formatBytes(row.node.size)
                            : '—'}
                      </span>
                    </td>
                    <td className="col-date">
                      <span className="truncate" title={row.node.modified}>
                        {formatRelative(row.node.modified)}
                      </span>
                    </td>
                    <td className="col-star" onClick={(event) => event.stopPropagation()}>
                      <div className="file-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="Ouvrir le dossier"
                          aria-label={`Ouvrir l’emplacement de ${row.node.name}`}
                          disabled={busyId === row.node.id}
                          onClick={() => void reveal(row)}
                        >
                          <FolderOpen size={13} />
                        </button>
                        {!row.node.children ? (
                          <button
                            type="button"
                            className="icon-btn"
                            title="Télécharger"
                            aria-label={`Télécharger ${row.node.name}`}
                            onClick={() => download(row.account, row.node)}
                          >
                            <Download size={13} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        )}
      </div>

      {searching ? (
        <div className="search-status">
          <span>
            {formatDecimal(total)} résultat{total > 1 ? 's' : ''} dans {scopeLabel}
          </span>
          {pending.length && scope === 'all' ? (
            <span className="search-status__pending">
              · {formatDecimal(pending.length)} compte{pending.length > 1 ? 's' : ''} encore
              interrogé{pending.length > 1 ? 's' : ''}
            </span>
          ) : null}
          {failed.map((item) => (
            <span key={item.account?.id} className="search-status__error">
              · {item.account?.name} : {item.state?.error}
            </span>
          ))}
        </div>
      ) : (
        <div className="search-status">
          <span>
            Seul le texte saisi est envoyé à Google ; aucun fichier n’est téléchargé ni modifié.
          </span>
        </div>
      )}
    </div>
  );
}
