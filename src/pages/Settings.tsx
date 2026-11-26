import { useEffect, useState } from 'react';
import {
  Check,
  FolderCog,
  FolderOpen,
  KeyRound,
  Info,
  Minus,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useStore } from '../store';
import { formatBytes, formatDecimal, formatNumber } from '../lib/format';
import { Modal } from '../components/Modal';
import { BrandMark } from '../components/BrandMark';
import { useToast } from '../components/toast';
import { getBridge, isDesktop } from '../lib/bridge';
import { useGoogleClientStatus } from '../hooks/useGoogle';
import { describeUpdate, useUpdater } from '../hooks/useUpdater';

// Plus de liste inventée : le dossier par défaut est celui du système, et le
// bouton ouvre la boîte de dialogue de Windows.
const SYSTEM_FOLDER_LABEL = 'Dossier du système (Téléchargements)';

export function Settings() {
  const { state, dispatch } = useStore();
  const toast = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  const updater = useUpdater();
  /** Chemin réel du dossier système : sans lui, ce réglage reste abstrait. */
  const [systemFolder, setSystemFolder] = useState('');

  useEffect(() => {
    let active = true;
    void getBridge()
      ?.google.folder?.()
      .then((folder) => {
        if (active) setSystemFolder(folder || '');
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const { status: googleStatus } = useGoogleClientStatus();
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
            <KeyRound size={13} />
            <span className="settings-group__title">Google Drive</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Autorisation Google</div>
              <div className="settings-row__desc">
                {!isDesktop()
                  ? 'Disponible dans l’application Windows : la connexion nécessite le navigateur système et le coffre chiffré de Windows.'
                  : googleStatus?.configured
                    ? 'Client OAuth déclaré. Les jetons sont chiffrés par Windows (DPAPI) et ne quittent pas cet ordinateur.'
                    : 'Aucun client OAuth déclaré. Renseignez l’identifiant client pour connecter un compte.'}
              </div>
            </div>
            <div className="settings-row__control">
              {isDesktop() ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    window.sessionStorage.setItem('boitier:google-connect', '1');
                    window.dispatchEvent(new CustomEvent('boitier:navigate-clouds'));
                  }}
                >
                  <KeyRound size={12} />
                  {googleStatus?.configured ? 'Connecter un compte' : 'Configurer'}
                </button>
              ) : (
                <span className="badge">Application Windows requise</span>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Comptes réels</div>
              <div className="settings-row__desc">
                Accès en lecture seule : lecture, recherche et téléchargement. Aucune
                modification ni suppression n’est possible depuis l’application.
              </div>
            </div>
            <div className="settings-row__control">
              <span className="badge">
                {formatDecimal(state.accounts.filter((a) => a.source === 'google').length)} connecté
                {state.accounts.filter((a) => a.source === 'google').length > 1 ? 's' : ''}
              </span>
            </div>
          </div>
        </section>

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
              <div className="settings-row__label">Taille du texte</div>
              <div className="settings-row__desc">
                Agrandit toute l’interface. Le réglage est conservé au redémarrage.
              </div>
            </div>
            <div className="settings-row__control">
              <div className="segmented">
                {(
                  [
                    [1, '100 %'],
                    [1.1, '110 %'],
                    [1.2, '120 %'],
                    [1.3, '130 %'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`segmented__item${
                      Math.abs(settings.textScale - value) < 0.001 ? ' is-active' : ''
                    }`}
                    onClick={() => patch({ textScale: value })}
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
                Emplacement réel des fichiers téléchargés depuis Google Drive.
              </div>
            </div>
            <div className="settings-row__control settings-row__control--path">
              {/* Le chemin réel, pas un libellé : c'est lui qui décide où les
                  fichiers atterrissent, et il doit se lire en entier. */}
              <button
                type="button"
                className="path-chip"
                title={
                  settings.downloadFolder
                    ? `Ouvrir ${settings.downloadFolder}`
                    : 'Ouvrir le dossier du système'
                }
                onClick={() => {
                  const folder = settings.downloadFolder || systemFolder;
                  if (folder) void getBridge()?.google.openDirectory?.(folder);
                }}
              >
                <FolderOpen size={12} />
                <span>
                  {settings.downloadFolder || systemFolder || SYSTEM_FOLDER_LABEL}
                </span>
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={async () => {
                  const chosen = await getBridge()?.google.chooseFolder?.();
                  if (chosen) {
                    patch({ downloadFolder: chosen });
                    toast.push('Dossier de destination mis à jour', 'ok');
                  }
                }}
              >
                <FolderCog size={12} />
                Choisir…
              </button>
              {settings.downloadFolder ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  title="Revenir au dossier du système"
                  onClick={() => {
                    patch({ downloadFolder: '' });
                    toast.push('Retour au dossier du système', 'ok');
                  }}
                >
                  Système
                </button>
              ) : null}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Ranger par cloud et par type</div>
              <div className="settings-row__desc">
                Classe chaque fichier dans « Google Drive » puis dans un dossier
                par nature : Videos, Audio, Images, Documents, Archives.
              </div>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                role="switch"
                aria-checked={settings.organizeDownloads}
                className={`switch${settings.organizeDownloads ? ' is-on' : ''}`}
                onClick={() => patch({ organizeDownloads: !settings.organizeDownloads })}
                aria-label="Ranger par cloud et par type"
              />
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
            <span className="settings-group__title">Données locales</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">Données conservées sur cet ordinateur</div>
              <div className="settings-row__desc">
                {formatNumber(state.accounts.length)} compte
                {state.accounts.length > 1 ? 's' : ''} · {formatBytes(totalUsed)} indexés ·{' '}
                {formatDecimal(state.favorites.length)} favoris ·{' '}
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
            <RefreshCw size={13} />
            <span className="settings-group__title">Mises à jour</span>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__label">
                Version {updater.state.currentVersion}
                {updater.state.status === 'ready' ? (
                  <span className="badge badge--ok" style={{ marginLeft: 8 }}>
                    {updater.state.version} prête
                  </span>
                ) : null}
              </div>
              <div className="settings-row__desc">{describeUpdate(updater.state)}</div>
              {updater.state.status === 'downloading' ||
              updater.state.status === 'available' ? (
                <div
                  className="update-bar"
                  role="progressbar"
                  aria-label="Téléchargement de la mise à jour"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={updater.state.percent ?? 0}
                >
                  <span
                    className={
                      updater.state.status === 'available'
                        ? 'update-bar__fill update-bar__fill--indeterminee'
                        : 'update-bar__fill'
                    }
                    style={
                      updater.state.status === 'available'
                        ? undefined
                        : { width: `${updater.state.percent ?? 0}%` }
                    }
                  />
                </div>
              ) : null}
            </div>
            <div className="settings-row__control">
              {updater.state.status === 'ready' ? (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={() => void updater.install()}
                >
                  <RefreshCw size={12} />
                  Redémarrer et installer
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!updater.supported || updater.busy}
                  onClick={() => void updater.check()}
                  title={
                    updater.supported
                      ? 'Vérifier maintenant'
                      : 'Disponible dans la version Windows installée'
                  }
                >
                  <RefreshCw size={12} />
                  {updater.state.status === 'downloading'
                    ? 'Téléchargement…'
                    : updater.busy
                      ? 'Vérification…'
                      : 'Rechercher'}
                </button>
              )}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row__text">
              <div className="settings-row__desc">
                Une nouvelle version se télécharge en arrière-plan et ne s’installe
                jamais sans votre clic. L’installeur s’affiche, comme lors d’une
                installation habituelle.
              </div>
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
                Application personnelle de gestion multi-cloud · version {__APP_VERSION__}
                {isDesktop() ? ' (Windows)' : ' (aperçu navigateur)'}
              </div>
            </div>
            <div className="settings-version">
              <span className="badge">{isDesktop() ? 'Windows' : 'Navigateur'}</span>
            </div>
          </div>
          <div className="about-block">
            <div style={{ fontSize: 11, color: 'var(--text-4)', lineHeight: 1.6 }}>
              Application locale de gestion de vos fichiers Google Drive. Aucun serveur
              intermédiaire : les échanges ont lieu directement entre cette fenêtre et
              Google. Vos préférences et la liste de vos comptes sont conservées sur cet
              ordinateur ; les autorisations Google sont chiffrées par Windows.
            </div>
          </div>
        </section>
      </div>

      {resetOpen ? (
        <Modal
          title="Réinitialiser les données locales ?"
          description="Les favoris, transferts et réglages seront effacés. Vos comptes Google restent connectés."
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
                  toast.push('Données locales effacées', 'ok');
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
