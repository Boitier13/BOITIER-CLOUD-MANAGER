import { useState } from 'react';
import {
  Check,
  FolderCog,
  Info,
  Minus,
  Monitor,
  Moon,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useStore } from '../store';
import { formatBytes, formatDecimal, formatNumber } from '../lib/format';
import { Modal } from '../components/Modal';
import { BrandMark } from '../components/BrandMark';
import { useToast } from '../components/toast';

const FOLDERS = [
  'C:\\Users\\Boitier\\Téléchargements',
  'C:\\Users\\Boitier\\Vidéos\\Cloud',
  'D:\\Médias\\Téléchargements',
  'E:\\Sauvegardes\\Cloud',
];

export function Settings() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const { settings } = state;

  const patch = (value: Partial<typeof settings>) =>
    dispatch({ type: 'settings/patch', patch: value });

  const totalUsed = state.accounts.reduce((sum, a) => sum + a.usedBytes, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head__text">
          <div className="page-eyebrow">Préférences</div>
          <h1 className="page-title">Paramètres</h1>
          <p className="page-subtitle">
            Réglages essentiels appliqués immédiatement et conservés sur cet ordinateur.
          </p>
        </div>
      </div>

      <div className="settings">
        <section className="settings-group">
          <div className="settings-group__head">
            <Monitor size={13} />
            <span className="settings-group__title">Apparence</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Thème</div>
              <div className="settings-row__desc">
                Interface sombre graphite ou variante claire chaude.
              </div>
            </div>
            <div className="settings-row__control">
              <div className="theme-picker">
                {(
                  [
                    { id: 'dark', label: 'Sombre', icon: Moon },
                    { id: 'light', label: 'Clair', icon: Sun },
                  ] as const
                ).map((theme) => (
                  <button
                    key={theme.id}
                    type="button"
                    className={`theme-swatch${settings.theme === theme.id ? ' is-active' : ''}`}
                    onClick={() => patch({ theme: theme.id })}
                    aria-pressed={settings.theme === theme.id}
                  >
                    <span
                      className="theme-swatch__preview"
                      style={
                        theme.id === 'dark'
                          ? {
                              ['--sw-rail' as string]: '#0d0e11',
                              ['--sw-bg' as string]: '#121417',
                              ['--sw-line' as string]: 'rgba(255,255,255,0.12)',
                            }
                          : {
                              ['--sw-rail' as string]: '#e9e5dd',
                              ['--sw-bg' as string]: '#fbfaf7',
                              ['--sw-line' as string]: 'rgba(28,25,20,0.14)',
                            }
                      }
                    >
                      <span className="theme-swatch__rail" />
                      <span className="theme-swatch__body">
                        <span className="theme-swatch__bar theme-swatch__bar--accent" />
                        <span className="theme-swatch__bar" style={{ width: '70%' }} />
                        <span className="theme-swatch__bar" style={{ width: '50%' }} />
                      </span>
                    </span>
                    <span className="theme-swatch__label">
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <theme.icon size={11} />
                        {theme.label}
                      </span>
                      {settings.theme === theme.id ? (
                        <span className="theme-swatch__check">
                          <Check size={11} strokeWidth={3} />
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Densité d’affichage</div>
              <div className="settings-row__desc">
                Compact resserre les listes pour afficher davantage de fichiers.
              </div>
            </div>
            <div className="settings-row__control">
              <div className="segmented">
                {(
                  [
                    ['confort', 'Confort'],
                    ['compact', 'Compact'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`segmented__item${settings.density === value ? ' is-active' : ''}`}
                    onClick={() => patch({ density: value })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group__head">
            <FolderCog size={13} />
            <span className="settings-group__title">Téléchargements</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Dossier de destination</div>
              <div className="settings-row__desc">
                Chemin fictif utilisé par la file simulée.
              </div>
            </div>
            <div className="settings-row__control">
              <select
                className="select"
                value={settings.downloadFolder}
                onChange={(event) => patch({ downloadFolder: event.target.value })}
                style={{ maxWidth: 300 }}
                aria-label="Dossier de téléchargement par défaut"
              >
                {FOLDERS.map((folder) => (
                  <option key={folder} value={folder}>
                    {folder}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Téléchargements simultanés</div>
              <div className="settings-row__desc">
                Nombre de transferts actifs autorisés dans la file (1 à 6).
              </div>
            </div>
            <div className="settings-row__control">
              <div className="stepper">
                <button
                  type="button"
                  onClick={() =>
                    patch({ concurrent: Math.max(1, settings.concurrent - 1) })
                  }
                  disabled={settings.concurrent <= 1}
                  aria-label="Diminuer"
                >
                  <Minus size={12} />
                </button>
                <span className="stepper__value">{settings.concurrent}</span>
                <button
                  type="button"
                  onClick={() =>
                    patch({ concurrent: Math.min(6, settings.concurrent + 1) })
                  }
                  disabled={settings.concurrent >= 6}
                  aria-label="Augmenter"
                >
                  <Plus size={12} />
                </button>
              </div>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Confirmer les suppressions</div>
              <div className="settings-row__desc">
                Demande une confirmation avant de retirer un compte.
              </div>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                role="switch"
                aria-checked={settings.confirmDelete}
                className={`switch${settings.confirmDelete ? ' is-on' : ''}`}
                onClick={() => patch({ confirmDelete: !settings.confirmDelete })}
                aria-label="Confirmer les suppressions"
              />
            </div>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group__head">
            <SlidersHorizontal size={13} />
            <span className="settings-group__title">Données de démonstration</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Contenu local</div>
              <div className="settings-row__desc">
                {formatNumber(state.accounts.length)} comptes · {formatBytes(totalUsed)}{' '}
                fictifs · {formatDecimal(state.favorites.length)} favoris ·{' '}
                {formatDecimal(state.downloads.length)} transferts
              </div>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setResetOpen(true)}
              >
                <RotateCcw size={12} />
                Réinitialiser
              </button>
            </div>
          </div>
        </section>

        <section className="settings-group">
          <div className="settings-group__head">
            <Info size={13} />
            <span className="settings-group__title">À propos</span>
          </div>
          <div className="about-block">
            <span className="about-block__mark">
              <BrandMark size={20} />
            </span>
            <div>
              <div className="about-block__name">BOITIER CLOUD MANAGER</div>
              <div className="about-block__meta">
                Application personnelle de gestion multi-cloud · version 0.1.0 (front-end)
              </div>
            </div>
            <div className="settings-version">
              <span className="badge">Démonstration</span>
            </div>
          </div>
          <div className="about-block">
            <div style={{ fontSize: 11, color: 'var(--text-4)', lineHeight: 1.6 }}>
              Interface locale de démonstration. Aucune connexion aux fournisseurs, aucun
              téléchargement réel, aucune API externe. Les données fictives sont conservées
              dans le stockage local du navigateur et pourront être remplacées par le
              back-end ultérieurement.
            </div>
          </div>
        </section>
      </div>

      {resetOpen ? (
        <Modal
          title="Réinitialiser la démonstration ?"
          description="Les comptes, favoris, transferts et réglages seront restaurés à leur état initial."
          icon={<RotateCcw size={15} />}
          onClose={() => setResetOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setResetOpen(false)}
              >
                Annuler
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  dispatch({ type: 'data/reset' });
                  setResetOpen(false);
                  toast.push('Données de démonstration restaurées', 'ok');
                }}
              >
                Restaurer l’état initial
              </button>
            </>
          }
        >
          <div className="callout callout--warn">
            <Info size={13} />
            <span>
              Cette action remplace vos modifications locales (comptes ajoutés, noms
              modifiés, favoris, file) par le jeu de données d’origine.
            </span>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
