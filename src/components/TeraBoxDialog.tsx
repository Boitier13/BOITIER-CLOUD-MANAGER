import { useState } from 'react';
import { LockKeyhole, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Account } from '../data/catalog';
import { useTeraBoxConnect } from '../hooks/useTeraBox';
import { Modal } from './Modal';

export function TeraBoxDialog({ onClose, onConnected, reconnect }: { onClose: () => void; onConnected: () => void; reconnect?: Account }) {
  const connect = useTeraBoxConnect();
  const [name, setName] = useState(reconnect?.email ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError('');
    const result = await connect(name.trim(), reconnect?.teraboxId);
    setBusy(false);
    if (result.ok) onConnected(); else setError(result.error);
  };
  return <Modal title={reconnect ? `Reconnecter ${reconnect.name}` : 'Connecter TeraBox'}
    description="Accès Web non officiel et provisoire : il peut cesser de fonctionner si TeraBox modifie son site."
    icon={<ShieldCheck size={16} />} onClose={onClose}
    footer={<><button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>Annuler</button><button type="button" className="btn btn--primary" disabled={!name.trim() || busy} onClick={() => void submit()}>{busy ? 'Connexion en cours…' : 'Ouvrir TeraBox'}</button></>}>
    <div className="field"><label className="field__label" htmlFor="terabox-name">Nom du compte (pour le reconnaître)</label><input id="terabox-name" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. : mon adresse TeraBox" /></div>
    <p className="dialog__hint">Une fenêtre TeraBox s’ouvrira. Connectez-vous sur le site, puis fermez cette fenêtre pour terminer. Répétez pour chaque compte.</p>
    {error ? <p className="dialog__error" role="alert"><TriangleAlert size={13} /> {error}</p> : null}
    <p className="dialog__hint"><LockKeyhole size={12} /> Votre session est conservée chiffrée par Windows. Ne communiquez jamais votre mot de passe ou cookie.</p>
  </Modal>;
}
