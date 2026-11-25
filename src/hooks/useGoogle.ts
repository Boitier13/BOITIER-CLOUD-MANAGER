/**
 * Accès Google côté interface, avec repli propre hors Electron.
 *
 * Les composants n'appellent jamais `window.boitier` directement : ce module
 * centralise les vérifications et garde le rendu identique dans un navigateur.
 */

import { useCallback, useEffect, useState } from 'react';
import { getBridge, isDesktop, type GoogleClientStatus } from '../lib/bridge';
import { probeAccounts, realAccountId } from '../lib/google';
import { useStore } from '../store';

export function useGoogleClientStatus(): {
  status: GoogleClientStatus | null;
  reload: () => Promise<void>;
  ready: boolean;
} {
  const [status, setStatus] = useState<GoogleClientStatus | null>(null);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge) {
      setStatus(null);
      setReady(true);
      return;
    }
    try {
      setStatus(await bridge.google.status());
    } catch {
      setStatus({ configured: false, source: 'none' });
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { status, reload, ready };
}

/** Ajoute ou met à jour un compte réel dans l'état de l'application. */
export function useGoogleAccountSync(): (account: {
  accountId: string;
  name: string;
  email: string;
  picture?: string;
  usedBytes: number;
  quotaBytes: number;
  status: 'connected' | 'expired';
}) => void {
  const { state, dispatch } = useStore();

  return useCallback(
    (info: {
      accountId: string;
      name: string;
      email: string;
      picture?: string;
      usedBytes: number;
      quotaBytes: number;
      status: 'connected' | 'expired';
    }) => {
      const existing = state.accounts.find(
        (account) =>
          (account.googleId && account.googleId === info.accountId) ||
          (account.source === 'google' && account.email === info.email),
      );
      dispatch({
        type: 'account/upsert',
        account: {
          id: existing?.id ?? `gdrive-real-${info.accountId}`,
          provider: 'gdrive',
          name: existing?.name ?? info.name,
          email: info.email,
          status: info.status,
          usedBytes: info.usedBytes,
          quotaBytes: info.quotaBytes || existing?.quotaBytes || 0,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          seed: existing?.seed ?? 7,
          source: 'google',
          googleId: info.accountId,
          localTree: false,
          ...(info.picture ? { avatarUrl: info.picture } : {}),
        },
      });
    },
    [dispatch, state.accounts],
  );
}

/** Révoque l'accès côté Google et retire le compte du coffre. */
export async function disconnectGoogle(accountId: string): Promise<void> {
  await getBridge()?.google.disconnect(accountId);
}

export { isDesktop, realAccountId, probeAccounts };
