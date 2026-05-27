import { useState, useCallback, useEffect, useRef } from 'react';
import * as API from '../lib/backend/commands';
import type * as Types from '../lib/backend/types';

export interface UseGitDiffOptions {
  cwd: string | null;
  enabled?: boolean;
}

export type GitDiffErrorType = 'not_a_git_repository' | 'runtime' | null;

export interface UseGitDiffReturn {
  data: Types.GitDiffResult | null;
  isLoading: boolean;
  error: string | null;
  errorType: GitDiffErrorType;
  refresh: () => Promise<void>;
}

export function useGitDiff(options: UseGitDiffOptions): UseGitDiffReturn {
  const { cwd, enabled = true } = options;

  const [data, setData] = useState<Types.GitDiffResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorType, setErrorType] = useState<GitDiffErrorType>(null);
  const seqRef = useRef(0);
  const debounceRef = useRef<number | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!cwd) return;

    const seq = ++seqRef.current;
    setIsLoading(true);
    setError(null);
    setErrorType(null);

    try {
      const result = await API.getGitDiff(cwd);
      if (seq === seqRef.current) setData(result);
    } catch (err) {
      if (seq === seqRef.current) {
        // Try to parse structured error from backend
        let parsedErrorType: GitDiffErrorType = 'runtime';
        let message: string;

        // Handle both Tauri and Web error formats
        const errorObj = err as any;
        
        // Tauri errors: the error object directly has code and message properties
        // Web errors: err is an Error instance with message containing JSON string
        if (errorObj && typeof errorObj === 'object') {
          // Check if error has code property directly (Tauri format)
          if (errorObj.code === 'not_a_git_repository') {
            parsedErrorType = 'not_a_git_repository';
            message = errorObj.message || 'Not a Git repository';
          } else if (err instanceof Error) {
            // Web format: message might contain JSON
            message = err.message;
            try {
              const parsed = JSON.parse(message);
              if (parsed && parsed.code === 'not_a_git_repository') {
                parsedErrorType = 'not_a_git_repository';
                message = parsed.message || message;
              }
            } catch {
              // Not JSON, keep original message
            }
          } else if (errorObj.message) {
            message = String(errorObj.message);
          } else {
            message = 'Failed to load git diff';
          }
        } else {
          message = 'Failed to load git diff';
        }

        setErrorType(parsedErrorType);
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
      setErrorType(null);
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

  return { data, isLoading, error, errorType, refresh };
}
