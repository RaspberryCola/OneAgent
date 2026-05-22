import { useState, useCallback, useEffect, useRef } from 'react';
import * as API from '../lib/backend/commands';
import type * as Types from '../lib/backend/types';

export interface UseGitDiffOptions {
  cwd: string | null;
  enabled?: boolean;
}

export interface UseGitDiffReturn {
  data: Types.GitDiffResult | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useGitDiff(options: UseGitDiffOptions): UseGitDiffReturn {
  const { cwd, enabled = true } = options;

  const [data, setData] = useState<Types.GitDiffResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!cwd) return;

    const seq = ++seqRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const result = await API.getGitDiff(cwd);
      if (seq === seqRef.current) setData(result);
    } catch (err) {
      if (seq === seqRef.current) {
        const message = err instanceof Error ? err.message : 'Failed to load git diff';
        setError(message);
        setData(null);
      }
    } finally {
      if (seq === seqRef.current) setIsLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (!enabled || !cwd) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
    }
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      void fetchDiff();
    }, 300);

    return () => {
      seqRef.current++;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [cwd, enabled, fetchDiff]);

  const refresh = useCallback(async () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    await fetchDiff();
  }, [fetchDiff]);

  return { data, isLoading, error, refresh };
}
