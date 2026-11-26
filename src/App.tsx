import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  CircleDot,
  Download,
  HardDrive,
  Keyboard,
  Search,
  Star,
} from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Modal } from './components/Modal';
import { useToast } from './components/toast';
import { Home } from './pages/Home';
import { Clouds } from './pages/Clouds';
import { Files } from './pages/Files';
import { SearchPage } from './pages/Search';
import { Storage } from './pages/Storage';
import { Recent } from './pages/Recent';
import { Downloads } from './pages/Downloads';
import { Favorites } from './pages/Favorites';
import { Settings } from './pages/Settings';
import {
  PROVIDERS,
  PROVIDER_LIST,
  type ProviderId,
} from './data/catalog';
import { useFreezeWatchdog } from './hooks/useFreezeWatchdog';
import { useCatalog, useStore, type CatalogEntry, type Route } from './store';
import { formatDecimal, formatSpeed } from './lib/format';

export default function App() {
  // Mesure des figements : une ligne dans le journal à chaque blocage > 1,2 s.
  useFreezeWatchdog();
  const { state, dispatch } = useStore();
  const catalog = useCatalog();
  const toast = useToast();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const navigate = useCallback(
    (route: Route) => {
      dispatch({ type: 'route', route });
    },
    [dispatch],
  );

  const openEntry = useCallback(
    (entry: CatalogEntry) => {
      dispatch({
        type: 'explorer/open',
        accountId: entry.accountId,
        path: entry.parentPath,
      });
    },
    [dispatch],
  );

  const openAccount = useCallback(
    (accountId: string) => {
      dispatch({ type: 'explorer/open', accountId });
      const account = state.accounts.find((a) => a.id === accountId);
      if (account) toast.push(`${account.name} ouvert dans l’explorateur`);
    },
    [dispatch, state.accounts, toast],
  );

  // Raccourci vers Clouds (depuis les paramètres : configurer Google).
  useEffect(() => {
    const onNavigateClouds = () => {
      dispatch({ type: 'route', route: { name: 'clouds', provider: 'gdrive' } });
    };
    window.addEventListener('boitier:navigate-clouds', onNavigateClouds);
    return () => window.removeEventListener('boitier:navigate-clouds', onNavigateClouds);
  }, [dispatch]);

  // Raccourcis clavier globaux.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);

      if (event.key === '?' && !typing) {
        setShortcutsOpen(true);
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === '1') {
        event.preventDefault();
        navigate({ name: 'home' });
      } else if (key === '2') {
        event.preventDefault();
        navigate({ name: 'files' });
      } else if (key === '7') {
        event.preventDefault();
        navigate({ name: 'search' });
      } else if (key === '3') {
        event.preventDefault();
        navigate({ name: 'downloads' });
      } else if (key === '4') {
        event.preventDefault();
        navigate({ name: 'favorites' });
      } else if (key === '5') {
        event.preventDefault();
        navigate({ name: 'storage' });
      } else if (key === '6') {
        event.preventDefault();
        navigate({ name: 'recent' });
      } else if (key === ',') {
        event.preventDefault();
        navigate({ name: 'settings' });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);

  const activeDownloads = state.downloads.filter((item) => item.status === 'active');
  const queue = state.downloads.filter((item) => item.status !== 'done');
  const totalSpeed = activeDownloads.reduce((sum, item) => sum + item.speed, 0);
  const totalCount = catalog.entries.length;
  const realCount = state.accounts.filter((account) => account.source === 'google').length;

  const explorerLabel = useMemo(() => {
    const account = state.accounts.find((a) => a.id === state.explorer.accountId);
    if (!account) return '—';
    const base = `${account.name} · ${PROVIDERS[account.provider].name}`;
    return state.explorer.path.length ? `${base} / ${state.explorer.path.join('/')}` : base;
  }, [state.accounts, state.explorer.accountId, state.explorer.path]);

  const currentRouteKey = `${state.route.name}-${
    state.route.name === 'clouds' ? state.route.provider : ''
  }`;

  const renderPage = () => {
    switch (state.route.name) {
      case 'home':
        return (
          <Home
            onNavigate={navigate}
            onOpenEntry={openEntry}
            onAddAccount={(provider?: ProviderId) => {
              if (provider) navigate({ name: 'clouds', provider });
              else navigate({ name: 'clouds', provider: 'gdrive' });
            }}
          />
        );
      case 'clouds':
        return (
          <Clouds
            provider={state.route.provider}
            onNavigate={navigate}
            onOpenAccount={openAccount}
          />
        );
      case 'files':
        return <Files />;
      case 'search':
        return <SearchPage />;
      case 'downloads':
        return <Downloads onNavigate={navigate} />;
      case 'favorites':
        return <Favorites onOpenEntry={openEntry} />;
      case 'storage':
        return <Storage onNavigate={navigate} />;
      case 'recent':
        return <Recent onNavigate={navigate} />;
      case 'settings':
        return <Settings />;
      default:
        return null;
    }
  };

  return (
    <div className="app">
      <Sidebar onNavigate={navigate} />
      <div className="app__main">
        <div className="app__content" key={currentRouteKey}>
          {renderPage()}
        </div>
        <StatusBar
          left={
            <>
              <span className="statusbar__item">
                <CircleDot
                  size={10}
                  style={{ color: realCount ? 'var(--accent)' : 'var(--ok)' }}
                />
                {formatDecimal(state.accounts.length)} compte
                {state.accounts.length > 1 ? 's' : ''} ·{' '}
                {realCount
                  ? `${formatDecimal(realCount)} réel${realCount > 1 ? 's' : ''}`
                  : `${formatDecimal(PROVIDER_LIST.length)} fournisseurs`}
              </span>
              <span className="statusbar__item statusbar__item--optional">
                <HardDrive size={10} />
                {formatDecimal(totalCount)} fichiers indexés
              </span>
              {queue.length ? (
                <button
                  type="button"
                  className="statusbar__item statusbar__item--button"
                  onClick={() => navigate({ name: 'downloads' })}
                >
                  <Download size={10} />
                  {formatDecimal(activeDownloads.length)} actifs · {formatSpeed(totalSpeed)}
                </button>
              ) : null}
            </>
          }
          right={
            <>
              <span
                className="statusbar__item statusbar__item--optional"
                title="Emplacement courant de l’explorateur"
                style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {explorerLabel}
              </span>
              <span className="statusbar__item statusbar__item--optional">
                <Star size={10} />
                {formatDecimal(state.favorites.length)}
              </span>
              <button
                type="button"
                className="statusbar__item statusbar__item--button"
                onClick={() => setShortcutsOpen(true)}
                title="Raccourcis clavier"
              >
                <Keyboard size={11} />
                <span className="tnum">?</span>
              </button>
            </>
          }
        />
      </div>

      {shortcutsOpen ? (
        <Modal
          title="Raccourcis clavier"
          description="Navigation rapide dans l’application."
          icon={<Keyboard size={15} />}
          onClose={() => setShortcutsOpen(false)}
          footer={
            <button
              type="button"
              className="btn"
              onClick={() => setShortcutsOpen(false)}
            >
              <Check size={13} />
              Compris
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              ['Accueil', 'Ctrl + 1'],
              ['Explorateur', 'Ctrl + 2'],
              ['Recherche', 'Ctrl + 7'],
              ['Téléchargements', 'Ctrl + 3'],
              ['Favoris', 'Ctrl + 4'],
              ['Stockage', 'Ctrl + 5'],
              ['Récents', 'Ctrl + 6'],
              ['Paramètres', 'Ctrl + ,'],
              ['Tout sélectionner dans un dossier', 'Ctrl + A'],
              ['Vider la sélection / le filtre', 'Échap'],
              ['Cette fenêtre', '?'],
            ].map(([label, keys]) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: 11.5,
                  color: 'var(--text-2)',
                }}
              >
                <span>{label}</span>
                <span className="kbd" style={{ minWidth: 54 }}>
                  {keys}
                </span>
              </div>
            ))}
          </div>
          <div className="callout">
            <Search size={13} />
            <span>
              Le filtre de l’explorateur agit sur le dossier courant. Les filtres de la page
              Clouds et des favoris sont indépendants.
            </span>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
