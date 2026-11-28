import { useCallback, useEffect } from 'react';
import type { Account } from '../data/catalog';
import { getBridge, type TeraBoxAccountInfo } from '../lib/bridge';
import { messageLisible } from '../lib/errors';
import { useStore } from '../store';

function toAccount(info: TeraBoxAccountInfo, existing?: Account): Account {
  return {
    id: existing?.id ?? `terabox-real-${info.accountId}`, provider: 'terabox', source: 'terabox', teraboxId: info.accountId,
    name: existing?.name ?? info.name, email: info.name, status: info.status,
    usedBytes: info.usedBytes, quotaBytes: info.quotaBytes,
    createdAt: existing?.createdAt ?? new Date().toISOString(), seed: existing?.seed ?? 0, localTree: false,
  };
}
export function useTeraBoxSync(): void {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const client = getBridge()?.terabox;
    if (!client) return;
    let alive = true;
    void client.accounts().then((accounts) => {
      if (alive) dispatch({ type: 'account/addMany', accounts: accounts.map((info) => toAccount(info, state.accounts.find((a) => a.provider === 'terabox' && a.teraboxId === info.accountId))) });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
}
export function useTeraBoxConnect() {
  const { state, dispatch } = useStore();
  return useCallback(async (name: string, expectedId?: string) => {
    const client = getBridge()?.terabox;
    if (!client) return { ok: false as const, error: 'TeraBox est disponible dans l’application Windows.' };
    try {
      const info = await client.connect(name, expectedId);
      const existing = state.accounts.find((a) => a.provider === 'terabox' && a.teraboxId === info.accountId);
      dispatch({ type: 'account/upsert', account: toAccount(info, existing) });
      return { ok: true as const };
    } catch (cause) { return { ok: false as const, error: messageLisible(cause) }; }
  }, [dispatch, state.accounts]);
}
