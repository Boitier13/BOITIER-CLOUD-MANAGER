import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Download, FolderDown, Loader2, TriangleAlert } from 'lucide-react';
import { Modal } from './Modal';
import { getBridge, type GoogleFolderPlan } from '../lib/bridge';
import { formatBytes, plural } from '../lib/format';

/**
 * Téléchargement d'un dossier entier.
 *
 * Le parcours de l'arborescence est fait par le processus principal : un dossier
 * de plusieurs milliers de fichiers ne bloque pas la fenêtre, et l'interface ne
 * reçoit qu'un plan (chemins relatifs, tailles) avant de lancer les transferts.
 *
 * Deux temps volontairement distincts :
 *   1. « Préparer » — on compte les fichiers et on annonce la taille à venir ;
 *   2. « Télécharger » — chaque fichier part dans la file, à sa place.
 * Rien ne s'écrit avant le second clic : on ne veut pas remplir un disque par
 * surprise sur un dossier de 40 Go.
 */
export function FolderDownloadDialog({
  folderName,
  accountId,
  fileId,
  basePath,
  targetDir,
  onClose,
  onQueue,
}: {
  folderName: string;
  accountId: string;
  fileId: string;
  /** Chemin affiché du dossier, tel que l'explorateur le présente. */
  basePath: string[];
  /** Dossier de destination réglé dans les préférences. */
  targetDir: string;
  onClose: () => void;
  onQueue: (plan: GoogleFolderPlan, folderName: string, basePath: string[]) => void;
}) {
  const [plan, setPlan] = useState<GoogleFolderPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const bridge = useMemo(() => getBridge(), []);
  /** Évite un double appel (StrictMode monte le composant deux fois). */
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const client = bridge;
    if (!client?.google.plan) {
      setError('Le parcours d’un dossier demande la version Windows de l’application.');
      return;
    }
    setWorking(true);
    client.google
      .plan(accountId, fileId)
      .then((result) => setPlan(result))
      .catch((cause: Error) =>
        setError(cause?.message || 'Ce dossier n’a pas pu être parcouru.'),
      )
      .finally(() => setWorking(false));
  }, [accountId, bridge, fileId]);

  const prepared = Boolean(plan && plan.files.length > 0);

  return (
    <Modal
      title={`Télécharger « ${folderName} »`}
      description="Le dossier et tout ce qu’il contient sont enregistrés, en conservant l’arborescence."
      icon={<FolderDown size={16} />}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!prepared || working}
            onClick={() => {
              if (!plan) return;
              onQueue(plan, folderName, basePath);
              onClose();
            }}
          >
            <Download size={12} />
            Télécharger
          </button>
        </>
      }
    >
      {working && !plan ? (
        <div className="folder-plan">
          <Loader2 size={14} className="spin" />
          <span>Lecture de l’arborescence du dossier…</span>
        </div>
      ) : error ? (
        <div className="filetable-error" style={{ padding: 0, border: 'none', background: 'none' }}>
          <TriangleAlert size={18} />
          <p className="filetable-error__title">Dossier illisible</p>
          <p className="filetable-error__text">{error}</p>
        </div>
      ) : plan ? (
        <>
          <div className="folder-plan">
            <ArrowDownToLine size={14} />
            <span>
              <b>{plural(plan.files.length, 'fichier')}</b>
              {plan.folders.length > 0
                ? ` dans ${plural(plan.folders.length, 'sous-dossier')}`
                : ''}
              {' · '}
              <b>{formatBytes(plan.totalBytes)}</b> à télécharger
            </span>
          </div>

          <div className="folder-plan__path" title={targetDir}>
            <span className="folder-plan__label">Destination</span>
            <span className="folder-plan__value">
              {targetDir}\{folderName}
            </span>
          </div>

          {plan.folders.length > 0 ? (
            <div className="folder-plan__tree">
              {plan.folders.slice(0, 5).map((folder) => (
                <span key={folder} className="folder-plan__entry">
                  {folder}
                </span>
              ))}
              {plan.folders.length > 5 ? (
                <span className="folder-plan__entry folder-plan__entry--more">
                  + {plan.folders.length - 5} autre
                  {plan.folders.length - 5 > 1 ? 's' : ''}
                </span>
              ) : null}
            </div>
          ) : null}

          {plan.skipped.length > 0 ? (
            <div className="callout">
              <TriangleAlert size={13} style={{ flex: 'none', marginTop: 1 }} />
              <span>
                {plural(plan.skipped.length, 'document')} Google natif
                {plan.skipped.length > 1 ? 's' : ''} ne peu
                {plan.skipped.length > 1 ? 'vent' : 't'} pas être téléchargé
                {plan.skipped.length > 1 ? 's' : ''} tel quel : {plan.skipped.slice(0, 3).join(', ')}
                {plan.skipped.length > 3 ? '…' : ''}. Exportez-le
                {plan.skipped.length > 1 ? 's' : ''} depuis Google Drive.
              </span>
            </div>
          ) : null}

          {plan.truncated ? (
            <div className="callout">
              <TriangleAlert size={13} style={{ flex: 'none', marginTop: 1 }} />
              <span>
                Dossier très volumineux : seul le début a été préparé. Téléchargez les
                sous-dossiers séparément pour le reste.
              </span>
            </div>
          ) : null}
        </>
      ) : null}
    </Modal>
  );
}
