import { useEffect, useState } from 'react';
import { Check, ExternalLink, KeyRound, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Modal } from './Modal';
import { getBridge, type GoogleAccountInfo, type GoogleClientStatus } from '../lib/bridge';

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials';

/**
 * Les erreurs IPC arrivent parfois préfixées par Electron
 * (« Error invoking remote method… ») : on ne garde que le message utile.
 */
function readableError(cause: unknown, fallback: string): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? '');
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
  return cleaned || fallback;
}

async function openConsole(): Promise<void> {
  const opened = await getBridge()?.google.openExternal?.(CONSOLE_URL);
  if (!opened) window.open(CONSOLE_URL, '_blank', 'noopener');
}

/** Étape 1 : déclarer le client OAuth Google (une seule fois). */
export function GoogleSetupDialog({
  status,
  onClose,
  onSaved,
}: {
  status: GoogleClientStatus | null;
  onClose: () => void;
  onSaved: (status: GoogleClientStatus) => void;
}) {
  const [clientId, setClientId] = useState(status?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canSubmit = clientId.trim().length > 10 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const bridge = getBridge();
      if (!bridge) throw new Error('La connexion Google nécessite l’application Windows.');
      const next = await bridge.google.setClient(clientId.trim(), clientSecret.trim());
      onSaved(next);
    } catch (cause) {
      setError(readableError(cause, 'Enregistrement impossible.'));
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Configurer Google Drive"
      description="Une seule fois : déclarez l’application dans Google Cloud, puis collez son identifiant ici."
      icon={<KeyRound size={15} />}
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
            onClick={() => void submit()}
          >
            {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} strokeWidth={2.6} />}
            Enregistrer
          </button>
        </>
      }
    >
      <div className="callout">
        <ShieldCheck size={13} />
        <span>
          Autorisation en lecture seule. Vos identifiants sont chiffrés par Windows et ne
          quittent jamais cet ordinateur.
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="google-client-id">
          Identifiant client (Client ID)
        </label>
        <input
          id="google-client-id"
          className="input"
          value={clientId}
          onChange={(event) => setClientId(event.target.value)}
          placeholder="1234567890-abcdef.apps.googleusercontent.com"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint">
          Google Cloud → API et services → Identifiants → type « Application de bureau ».
        </span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="google-client-secret">
          Secret client
        </label>
        <input
          id="google-client-secret"
          className="input"
          type="password"
          value={clientSecret}
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder="GOCSPX-…"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="field__hint">
          Facultatif pour un client de bureau, mais recommandé si Google l’a fourni.
        </span>
      </div>

      <button type="button" className="btn btn--sm" onClick={() => void openConsole()}>
        <ExternalLink size={12} />
        Ouvrir la console Google Cloud
      </button>

      {error ? (
        <div className="callout callout--warn">
          <TriangleAlert size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </Modal>
  );
}

/** Étape 2 : connexion réelle (consentement Google dans le navigateur). */
export function GoogleConnectDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (account: GoogleAccountInfo) => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setPhase('waiting');
    setError(null);
    try {
      const bridge = getBridge();
      if (!bridge) throw new Error('La connexion Google nécessite l’application Windows.');
      const account = await bridge.google.connect();
      onConnected(account);
    } catch (cause) {
      setError(readableError(cause, 'La connexion a échoué.'));
      setPhase('error');
    }
  };

  useEffect(() => {
    void start();
    // La connexion démarre à l'ouverture du dialogue, une seule fois.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal
      title="Connexion à Google Drive"
      description="Votre navigateur va s’ouvrir pour autoriser l’accès en lecture seule."
      icon={<RefreshCw size={15} className={phase === 'waiting' ? 'spin' : ''} />}
      onClose={phase === 'waiting' ? () => undefined : onClose}
      footer={
        phase === 'error' ? (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              Fermer
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void start()}>
              <RefreshCw size={13} />
              Réessayer
            </button>
          </>
        ) : (
          <button type="button" className="btn" disabled>
            En attente de Google…
          </button>
        )
      }
    >
      {phase === 'error' ? (
        <div className="callout callout--warn">
          <TriangleAlert size={13} />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <div className="callout">
            <ShieldCheck size={13} />
            <span>
              Aucun mot de passe n’est demandé dans l’application. L’autorisation se donne
              chez Google ; seul un jeton de lecture chiffré est conservé ici.
            </span>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--text-3)', margin: '4px 0 0', lineHeight: 1.5 }}>
            Si le navigateur ne s’est pas ouvert, vérifiez qu’il n’est pas bloqué par une
            fenêtre déjà au premier plan.
          </p>
        </>
      )}
    </Modal>
  );
}
