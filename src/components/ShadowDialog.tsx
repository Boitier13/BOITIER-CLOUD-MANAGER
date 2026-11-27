import { useState } from 'react';
import { LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Account } from '../data/catalog';
import { useShadowConnect } from '../hooks/useShadow';
import { Modal } from './Modal';

export function ShadowDialog({ onClose, onConnected, reconnect }: { onClose: () => void; onConnected: () => void; reconnect?: Account }) {
  const connect = useShadowConnect();
  const [username, setUsername] = useState(reconnect?.email ?? '');
  const [token, setToken] = useState('');
  const [url, setUrl] = useState(reconnect?.shadowUrl ?? 'https://drive.shadow.tech/remote.php/webdav/');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = Boolean(username.trim() && token && url.trim() && !busy);
  const submit = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    const result = await connect(username, token, url, reconnect?.shadowId);
    setBusy(false);
    if (result.ok) { setToken(''); onConnected(); } else setError(result.error);
  };
  return (
    <Modal title={reconnect ? `Reconnecter ${reconnect.name}` : 'Connecter Shadow Drive'}
      description="Créez un jeton dédié dans Shadow Drive : Sync → créer un jeton. Recopiez les trois informations affichées par Shadow."
      icon={<ShieldCheck size={16} />} onClose={onClose}
      footer={<><button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Annuler</button><button type="button" className="btn btn--primary" onClick={() => void submit()} disabled={!ready}>{busy ? 'Connexion…' : 'Se connecter'}</button></>}>
      <div className="field"><label className="field__label" htmlFor="shadow-user">Identifiant WebDAV</label><input id="shadow-user" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></div>
      <div className="field"><label className="field__label" htmlFor="shadow-token">Jeton de sécurité WebDAV</label><input id="shadow-token" className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></div>
      <div className="field"><label className="field__label" htmlFor="shadow-url">Adresse WebDAV affichée par Shadow</label><input id="shadow-url" className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} /></div>
      {error ? <p className="dialog__error" role="alert"><TriangleAlert size={13} /> {error}</p> : null}
      <p className="dialog__hint"><LockKeyhole size={12} /> Le jeton dédié est chiffré par Windows pour les prochaines connexions. Ne le partagez pas et n’utilisez pas votre mot de passe principal.</p>
    </Modal>
  );
}
