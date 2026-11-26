/**
 * Accès MEGA côté interface.
 *
 * MEGA n'a pas d'OAuth : l'ouverture se fait par adresse et mot de passe. Le
 * mot de passe ne quitte la fenêtre que le temps de l'appel, n'est jamais
 * écrit, et la session obtenue est conservée chiffrée par le système.
 */

import { useCallback, useEffect } from 'react';
import type { Account } from '../data/catalog';
import { GB } from '../data/catalog';
import { getBridge, type MegaAccountInfo } from '../lib/bridge';
import { useStore } from '../store';

/** Message d'erreur lisible : Electron préfixe parfois les erreurs IPC. */
export function readableMegaError(cause: unknown): string {
  const brut = cause instanceof Error ? cause.message : String(cause ?? '');
  return (
    brut
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'MEGA n’a pas répondu'
  );
}

/** Traduit un compte MEGA du processus principal en compte d'application. */
export function toMegaAccount(info: MegaAccountInfo, existing?: Account): Account {
  return {
    id: existing?.id ?? `mega-real-${info.accountId}`,
    provider: 'mega',
    name: existing?.name ?? info.name,
    email: info.email,
    status: info.status,
    usedBytes: info.usedBytes,
    quotaBytes: info.quotaBytes || existing?.quotaBytes || 20 * GB,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    seed: existing?.seed ?? 11,
    source: 'mega',
    megaId: info.accountId,
    localTree: false,
  };
}

/**
 * Synchronise les comptes MEGA connus du processus principal.
 *
 * Appelé une fois au montage : les sessions restaurées depuis le disque
 * réapparaissent sans redemander de mot de passe.
 */
export function useMegaAccountSync(): void {
  const { state, dispatch } = useStore();

  useEffect(() => {
    const bridge = getBridge();
    if (!bridge?.mega) return;
    let vivant = true;
    void bridge.mega
      .accounts()
      .then((comptes) => {
        if (!vivant) return;
        for (const info of comptes) {
          const existant = state.accounts.find(
            (compte) => compte.megaId === info.accountId || compte.email === info.email,
          );
          dispatch({ type: 'account/upsert', account: toMegaAccount(info, existant) });
        }
      })
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
    // Volontairement au montage : une resynchronisation périodique réveillerait
    // l'interface sans rien apporter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** Ouvre une session MEGA, ou signale qu'un code de vérification est requis. */
export function useMegaConnect(): (
  email: string,
  password: string,
  secondFactor?: string,
) => Promise<{ ok: true } | { ok: false; error: string; needSecondFactor?: boolean }> {
  const { state, dispatch } = useStore();

  return useCallback(
    async (email: string, password: string, secondFactor?: string) => {
      const bridge = getBridge();
      if (!bridge?.mega) {
        return { ok: false, error: 'MEGA n’est disponible que dans l’application Windows.' };
      }
      try {
        const info = await bridge.mega.connect(email, password, secondFactor);
        const existant = state.accounts.find(
          (compte) => compte.megaId === info.accountId || compte.email === info.email,
        );
        dispatch({ type: 'account/upsert', account: toMegaAccount(info, existant) });
        return { ok: true as const };
      } catch (cause) {
        const message = readableMegaError(cause);
        return {
          ok: false as const,
          error: message,
          needSecondFactor: /deux étapes|two-factor|2fa|EMFAREQUIRED/i.test(message),
        };
      }
    },
    [dispatch, state.accounts],
  );
}
