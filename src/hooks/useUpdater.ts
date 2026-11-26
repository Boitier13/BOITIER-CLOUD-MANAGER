/**
 * État des mises à jour, côté interface.
 *
 * Le processus principal est la seule autorité : il vérifie, télécharge et
 * installe. Cette couche ne fait que refléter son état et transmettre deux
 * intentions — vérifier, installer. Dans un navigateur, aucun pont n'existe :
 * l'état vaut `unsupported` et les boutons sont inertes.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBridge, type UpdateState } from '../lib/bridge';

const INITIAL: UpdateState = {
  status: 'unsupported',
  currentVersion: __APP_VERSION__,
};

export interface UpdaterView {
  state: UpdateState;
  /** Vérification à la demande. */
  check: () => Promise<void>;
  /** Lance l'installation ; `false` si aucune version n'est prête. */
  install: () => Promise<boolean>;
  /** Vrai quand l'application tourne depuis une installation Windows. */
  supported: boolean;
  /** Une vérification ou un téléchargement est en cours. */
  busy: boolean;
}

export function useUpdater(): UpdaterView {
  const api = getBridge()?.updater;
  const [state, setState] = useState<UpdateState>(INITIAL);

  useEffect(() => {
    if (!api) {
      setState(INITIAL);
      return;
    }
    let alive = true;
    void api
      .state()
      .then((next) => {
        if (alive && next && typeof next === 'object') setState(next);
      })
      .catch(() => undefined);
    const off = api.onChange((next) => {
      if (next && typeof next === 'object') setState(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, [api]);

  const check = useCallback(async () => {
    if (!api) return;
    setState((current) => ({ ...current, status: 'checking', message: undefined }));
    try {
      const next = await api.check();
      if (next) setState(next);
    } catch (cause) {
      setState((current) => ({
        ...current,
        status: 'error',
        message: (cause as Error).message || 'Vérification impossible.',
      }));
    }
  }, [api]);

  const install = useCallback(async () => {
    if (!api) return false;
    try {
      return await api.install();
    } catch {
      return false;
    }
  }, [api]);

  return {
    state,
    check,
    install,
    supported: Boolean(api) && state.status !== 'unsupported',
    busy: state.status === 'checking' || state.status === 'downloading' || state.status === 'available',
  };
}

/**
 * Heure d'une vérification, en clair.
 *
 * « vérifiée » sans date ne prouve rien : l'utilisateur ne peut pas distinguer
 * une vérification faite il y a dix secondes d'une faite au démarrage. Avec
 * l'heure, il voit que le mécanisme tourne vraiment.
 */
export function describeCheckedAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const heure = `${date.getHours()} h ${String(date.getMinutes()).padStart(2, '0')}`;
  const jour = (valeur: Date) =>
    new Date(valeur.getFullYear(), valeur.getMonth(), valeur.getDate()).getTime();
  const ecart = Math.round((jour(now) - jour(date)) / 86_400_000);
  if (ecart === 0) return `à ${heure}`;
  if (ecart === 1) return `hier à ${heure}`;
  const mois = String(date.getMonth() + 1).padStart(2, '0');
  const quantieme = String(date.getDate()).padStart(2, '0');
  return `le ${quantieme}/${mois} à ${heure}`;
}

/** Phrase lisible décrivant l'état, sans jargon. */
export function describeUpdate(state: UpdateState): string {
  switch (state.status) {
    case 'unsupported':
      return state.message ?? 'Mises à jour disponibles dans la version installée uniquement.';
    case 'checking':
      return 'Recherche d’une version plus récente…';
    case 'available':
      return `Version ${state.version ?? 'récente'} trouvée — téléchargement en cours.`;
    case 'downloading':
      return `Téléchargement de la version ${state.version ?? 'récente'} — ${state.percent ?? 0} %.`;
    case 'ready':
      return `Version ${state.version ?? 'récente'} prête. Cliquez pour redémarrer et installer.`;
    case 'error':
      return state.message ?? 'Vérification impossible pour le moment.';
    default: {
      if (!state.checkedAt) return 'Aucune vérification depuis le démarrage.';
      const quand = describeCheckedAt(state.checkedAt);
      return quand
        ? `À jour — version ${state.currentVersion} vérifiée ${quand}.`
        : `À jour — version ${state.currentVersion} vérifiée.`;
    }
  }
}
