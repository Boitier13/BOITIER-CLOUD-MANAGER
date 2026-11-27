import { useCallback, useEffect } from 'react';
import type { Account } from '../data/catalog';
import { getBridge, type ShadowAccountInfo } from '../lib/bridge';
import { messageLisible } from '../lib/errors';
import { useStore } from '../store';

function toAccount(info: ShadowAccountInfo, existing?: Account): Account {
  return {
    id: existing?.id ?? `shadow-real-${info.accountId}`,
    provider: 'shadow', source: 'shadow', shadowId: info.accountId, shadowUrl: info.url,
    name: existing?.name ?? info.name, email: info.username,
    status: info.status, usedBytes: info.usedBytes, quotaBytes: info.quotaBytes,
    createdAt: existing?.createdAt ?? new Date().toISOString(), seed: existing?.seed ?? 0,
    localTree: false,
  };
}
export function useShadowAccountSync(): void {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const shadow = getBridge()?.shadow;
    if (!shadow) return;
    let alive = true;
    void shadow.accounts().then((accounts) => {
      if (!alive) return;
      dispatch({ type: 'account/addMany', accounts: accounts.map((info) => toAccount(info, state.accounts.find((a) => a.provider === 'shadow' && a.shadowId === info.accountId))) });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
}
export function useShadowConnect() {
  const { state, dispatch } = useStore();
  return useCallback(async (username: string, token: string, url: string, expectedId?: string) => {
    const shadow = getBridge()?.shadow;
    if (!shadow) return { ok: false as const, error: 'Shadow Drive est disponible dans l’application Windows.' };
    try {
      const info = await shadow.connect(username, token, url, expectedId);
      const existing = state.accounts.find((a) => a.provider === 'shadow' && a.shadowId === info.accountId);
      dispatch({ type: 'account/upsert', account: toAccount(info, existing) });
      return { ok: true as const };
    } catch (cause) { return { ok: false as const, error: messageLisible(cause) }; }
  }, [dispatch, state.accounts]);
}
