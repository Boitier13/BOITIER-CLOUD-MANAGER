import {
  Clock,
  Download,
  FolderTree,
  HardDrive,
  House,
  PieChart,
  Search as SearchIcon,
  Settings,
  Star,
} from 'lucide-react';
import { PROVIDER_LIST } from '../data/catalog';
import { BrandMark } from './BrandMark';
import { useStore, type Route } from '../store';
import { formatDecimal } from '../lib/format';

interface SidebarProps {
  onNavigate: (route: Route) => void;
}

const NAV = [
  { id: 'home', label: 'Accueil', icon: House },
  { id: 'files', label: 'Tous les fichiers', icon: FolderTree },
  { id: 'search', label: 'Recherche', icon: SearchIcon },
  { id: 'recent', label: 'Récents', icon: Clock },
  { id: 'downloads', label: 'Téléchargements', icon: Download },
  { id: 'favorites', label: 'Favoris', icon: Star },
  { id: 'storage', label: 'Stockage', icon: PieChart },
] as const;

export function Sidebar({ onNavigate }: SidebarProps) {
  const { state } = useStore();
  const { route } = state;

  const countFor = (provider: string) =>
    state.accounts.filter((account) => account.provider === provider).length;

  // Comptes connectés à un service réel (aujourd'hui : Google Drive).
  const liveCount = state.accounts.filter(
    (account) => account.source === 'google',
  ).length;

  const activeDownloads = state.downloads.filter(
    (item) => item.status === 'active' || item.status === 'queued',
  ).length;


  const navCount = (id: string) => {
    if (id === 'downloads') return activeDownloads || null;
    if (id === 'favorites') return state.favorites.length || null;
    return null;
  };

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand__mark">
          <BrandMark size={19} />
        </span>
        <span className="brand__text">
          <span className="brand__name">BOITIER</span>
          <span className="brand__sub">CLOUD MANAGER</span>
        </span>
      </div>

      <div className="sidebar__scroll">
        <div className="nav-section">
          <div className="nav-label">
            <span>Espace de travail</span>
          </div>
          {NAV.map((item) => {
            const Icon = item.icon;
            const isActive =
              route.name === item.id ||
              (item.id === 'files' && route.name === 'clouds');
            const count = navCount(item.id);
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-item${isActive ? ' is-active' : ''}`}
                onClick={() => onNavigate({ name: item.id } as Route)}
                aria-current={isActive ? 'page' : undefined}
                title={item.label}
              >
                <Icon size={15} strokeWidth={1.85} />
                <span>{item.label}</span>
                {count ? <span className="nav-item__count">{count}</span> : null}
              </button>
            );
          })}
        </div>

        <div className="nav-section">
          <div className="nav-label">
            <span>Clouds</span>
            <span className="nav-label__value tnum">{state.accounts.length}</span>
          </div>
          {PROVIDER_LIST.map((provider) => {
            const isActive = route.name === 'clouds' && route.provider === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                className={`cloud-item${isActive ? ' is-active' : ''}`}
                onClick={() => onNavigate({ name: 'clouds', provider: provider.id })}
                aria-current={isActive ? 'page' : undefined}
                title={`${provider.name} — ${countFor(provider.id)} compte(s)`}
              >
                <span
                  className="cloud-item__dot"
                  style={{ ['--dot' as string]: provider.brand }}
                />
                <span className="cloud-item__name">{provider.name}</span>
                {provider.id === 'gdrive' && liveCount > 0 ? (
                  <span className="rail-account__live" aria-label="compte réel connecté" />
                ) : null}
                <span className="cloud-item__count tnum">{countFor(provider.id)}</span>
              </button>
            );
          })}
        </div>

        <div className="nav-section">
          <div className="nav-label">
            <span>Système</span>
          </div>
          <button
            type="button"
            className={`nav-item${route.name === 'settings' ? ' is-active' : ''}`}
            onClick={() => onNavigate({ name: 'settings' })}
            aria-current={route.name === 'settings' ? 'page' : undefined}
            title="Paramètres"
          >
            <Settings size={15} strokeWidth={1.85} />
            <span>Paramètres</span>
          </button>
        </div>
      </div>

      <div className="sidebar__foot">
        <div className="demo-chip">
          <HardDrive size={13} strokeWidth={1.8} />
          <span>
            {liveCount > 0
              ? `${formatDecimal(liveCount)} compte${liveCount > 1 ? 's' : ''} connecté${
                  liveCount > 1 ? 's' : ''
                } · lecture seule`
              : 'Aucun compte connecté'}
          </span>
        </div>
      </div>
    </aside>
  );
}
