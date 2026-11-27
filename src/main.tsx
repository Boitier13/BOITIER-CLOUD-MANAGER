import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StoreProvider } from './store';
import { ToastProvider } from './components/toast';
import { reportTiming, signalReady } from './lib/bridge';
// Poids variables uniquement, sous-ensembles latin (application hors ligne) :
// DM Sans pour l'interface, Manrope pour les titres et les chiffres.
import '@fontsource-variable/dm-sans/wght.css';
import '@fontsource-variable/manrope/wght.css';
import './styles.css';

/**
 * Garde d'affichage : si l'interface n'arrive pas à se monter, on le dit.
 *
 * Cas réellement observé : au premier lancement après une mise à jour, la
 * fenêtre s'ouvre sur un cadre inerte — aucun menu ne réagit — et seule une
 * fermeture suivie d'une relance rétablit les choses. Un échec silencieux
 * rendait ce défaut indiagnosticable ; ici, l'erreur est affichée en clair.
 */
function reportFatal(error: unknown): void {
  const message =
    error instanceof Error ? `${error.name} : ${error.message}` : String(error);
  console.error('Interface interrompue', error);
  document.getElementById('boot')?.remove();
  const host = document.getElementById('root');
  if (!host) return;
  host.innerHTML = '';
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = [
    'max-width: 560px',
    'margin: 64px auto',
    'padding: 20px 22px',
    'border: 1px solid rgba(200,120,90,.45)',
    'border-radius: 10px',
    'font: 14px/1.55 system-ui, sans-serif',
    'color: #eceef1',
    'background: #181a1e',
  ].join(';');
  const title = document.createElement('strong');
  title.textContent = 'L’interface n’a pas pu démarrer.';
  const detail = document.createElement('p');
  detail.style.cssText = 'margin: 8px 0 0; color: #b3b9c2; word-break: break-word';
  detail.textContent = message;
  const hint = document.createElement('p');
  hint.style.cssText = 'margin: 12px 0 0; color: #808896';
  hint.textContent = 'Fermez puis relancez l’application.';
  box.append(title, detail, hint);
  host.append(box);
}

/**
 * Signale l'interface comme interactive **après** le premier rendu effectif :
 * dans un effet, donc seulement si React a réellement monté l'arbre.
 */
function ReadySignal(): null {
  useEffect(() => {
    // Repères de démarrage, écrits dans le journal par le processus principal.
    // Uniquement des mesures ponctuelles : aucun minuteur, aucun réveil.
    const debut = performance.now();
    reportTiming(`premier rendu (${Math.round(debut)} ms)`);
    // `PerformanceObserver` et `performance.getEntriesByType` n'existent pas
    // partout (rendu hors application, tests) : leur absence ne doit pas
    // interrompre le montage de l'interface.
    try {
      const releves = performance.getEntriesByType?.('paint') ?? [];
      const peinture = releves.find((entree) => entree.name === 'first-paint');
      if (peinture) reportTiming(`peinture (${Math.round(peinture.startTime)} ms)`);
    } catch {
      /* mesure indisponible : on continue */
    }
    void document.fonts?.ready.then(() => {
      const total = Math.round(performance.now());
      reportTiming(`polices prêtes (${total} ms)`);
    });
    signalReady();
    // L'interface a pris la main : l'écran de démarrage (peint en HTML, avant
    // tout chargement) n'a plus de raison d'occuper la fenêtre.
    document.getElementById('boot')?.remove();
  }, []);
  return null;
}

// Premier repère : le bundle a fini de s'exécuter. L'écart avec l'heure du
// chargement demandé mesure le temps passé dans le disque et l'analyse du
// fichier — c'est là que se cachent les secondes du démarrage.
reportTiming(`bundle exécuté (${Math.round(performance.now())} ms)`);

// Un seul repère, sans contenu de clic : si la fenêtre semble morte, savoir si
// Chromium reçoit au moins une action permet de distinguer focus et interface.
document.addEventListener('pointerdown', () => {
  reportTiming(`premier clic reçu · focus ${document.hasFocus() ? 'oui' : 'non'}`);
}, { once: true, capture: true });

const root = document.getElementById('root');

if (!root) {
  reportFatal(new Error('Élément racine introuvable dans la page'));
} else {
  try {
    createRoot(root).render(
      <StrictMode>
        <StoreProvider>
          <ToastProvider>
            <ReadySignal />
            <App />
          </ToastProvider>
        </StoreProvider>
      </StrictMode>,
    );
  } catch (error) {
    reportFatal(error);
  }
  // React 18 ne fournit pas de gestionnaire de rendu : on s'appuie sur les
  // événements globaux, qui couvrent les erreurs de module et de rendu.
  window.addEventListener('error', (event) => {
    if (event.error) reportFatal(event.error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportFatal(event.reason);
  });
}
