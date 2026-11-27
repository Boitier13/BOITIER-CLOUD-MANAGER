/**
 * Connexion à un compte MEGA.
 *
 * MEGA n'a pas d'OAuth : il faut l'adresse et le mot de passe. Le mot de passe
 * n'est jamais conservé — la session obtenue est stockée chiffrée par le
 * système, ce qui évite de le redemander au lancement suivant.
 *
 * La vérification en deux étapes n'est demandée qu'une fois : si MEGA réclame
 * un code, le champ apparaît au lieu d'afficher une erreur incompréhensible.
 */

import { useState } from 'react';
import { LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import { Modal } from './Modal';
import { useMegaConnect } from '../hooks/useMega';

export function MegaConnectDialog({
  onClose,
  onConnected,
  reconnect,
}: {
  onClose: () => void;
  onConnected: (nom: string) => void;
  /**
   * Reconnexion d'un compte existant : l'adresse est préremplie et la fiche
   * (nom, place dans la liste, favoris) est conservée. Sans cela, il fallait
   * retaper l'adresse de tête et craindre d'ajouter un doublon.
   */
  reconnect?: { email: string; name: string };
}) {
  const connect = useMegaConnect();
  const [email, setEmail] = useState(reconnect?.email ?? '');
  const [password, setPassword] = useState('');
  const [secondFactor, setSecondFactor] = useState('');
  const [besoinCode, setBesoinCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pret = email.trim().includes('@') && password.length > 0 && !busy;

  const submit = async () => {
    if (!pret) return;
    setBusy(true);
    setError(null);
    const resultat = await connect(email, password, besoinCode ? secondFactor : undefined);
    if (resultat.ok) {
      onConnected(email.trim());
      return;
    }
    setBusy(false);
    setError(resultat.error);
    if (resultat.needSecondFactor) {
      setBesoinCode(true);
      setError('Ce compte demande un code de vérification en deux étapes.');
    }
  };

  return (
    <Modal
      title={reconnect ? `Reconnecter ${reconnect.name}` : 'Connecter un compte MEGA'}
      description={
        reconnect
          ? 'La même adresse met à jour ce compte : son nom, sa place dans la liste et ses favoris sont conservés. Le mot de passe n’est jamais enregistré.'
          : 'Vos fichiers restent chez MEGA. Le mot de passe sert uniquement à ouvrir la session : il n’est jamais enregistré.'
      }
      icon={<ShieldCheck size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void submit()}
            disabled={!pret}
          >
            {busy ? 'Connexion…' : reconnect ? 'Se reconnecter' : 'Se connecter'}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor="mega-email">
          Adresse MEGA
        </label>
        <input
          id="mega-email"
          className="input"
          type="email"
          autoComplete="username"
          placeholder="vous@exemple.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="mega-password">
          Mot de passe
        </label>
        <input
          id="mega-password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </div>

      {besoinCode ? (
        <div className="field">
          <label className="field__label" htmlFor="mega-2fa">
            Code de vérification (6 chiffres)
          </label>
          <input
            id="mega-2fa"
            className="input"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={secondFactor}
            onChange={(event) => setSecondFactor(event.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </div>
      ) : null}

      {error ? (
        <p className="dialog__error" role="alert">
          <TriangleAlert size={13} /> {error}
        </p>
      ) : null}

      <p className="dialog__hint">
        <LockKeyhole size={12} /> Un compte gratuit suffit : l’application lit, télécharge et
        envoie. Les limites de transfert de MEGA s’appliquent comme dans un navigateur.
      </p>
    </Modal>
  );
}
