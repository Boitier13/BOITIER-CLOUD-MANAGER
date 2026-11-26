import { useEffect, useState } from 'react';
import { getBridge } from './bridge';

/**
 * Dossier de téléchargement du système, tel que le processus principal le voit.
 *
 * L'application n'écrit plus directement dans `Téléchargements` : le chemin
 * renvoyé ici se termine par `…/BOITIER-CLOUD-MANAGER`, le dossier commun où
 * tout est rassemblé. Une seule implémentation, sinon les écrans finissaient par
 * annoncer des destinations différentes.
 */
export function useSystemFolder(): string {
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

  return systemFolder;
}
