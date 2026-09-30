import { useCallback, useEffect, useState } from 'react';
import type { ModuleApi } from './local-api';

interface Settled<T> {
  readonly key: string;
  readonly nonce: number;
  readonly data: T | null;
  readonly error: string | null;
}

export function useCapability<T>(
  api: ModuleApi | null,
  workspaceId: string | null,
  capabilityId: string,
  input: unknown = {},
) {
  const inputJson = JSON.stringify(input);
  const key = api && workspaceId ? `${workspaceId}\u0000${capabilityId}\u0000${inputJson}` : null;
  const [nonce, setNonce] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  useEffect(() => {
    if (!api || !workspaceId || key === null) return;
    let live = true;
    api.read<T>(workspaceId, capabilityId, JSON.parse(inputJson)).then(
      (data) => {
        if (live) setSettled({ key, nonce, data, error: null });
      },
      (cause: unknown) => {
        if (live)
          setSettled({
            key,
            nonce,
            data: null,
            error: cause instanceof Error ? cause.message : 'Request failed',
          });
      },
    );
    return () => {
      live = false;
    };
  }, [api, workspaceId, capabilityId, inputJson, key, nonce]);
  // Results from a superseded request (other workspace/input, or before a refresh) are never shown.
  const current = settled && settled.key === key && settled.nonce === nonce ? settled : null;
  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return {
    data: current?.data ?? null,
    loading: key !== null && current === null,
    error: current?.error ?? null,
    refresh,
  };
}
