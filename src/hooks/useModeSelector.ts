import { useState, useEffect } from 'react';
import { useAppStore } from '../lib/store';
import * as API from '../lib/backend/commands';
import * as Types from '../lib/backend/types';
import { STORAGE_KEYS } from '../lib/constants';

// ============================================================================
// Types
// ============================================================================

export interface UseModeSelectorOptions {
  enabled?: boolean;
  onNotice?: (message: string | null) => void;
}

export interface UseModeSelectorReturn {
  // State
  activeModeState: Types.AcpSessionModeState | null;
  selectedValue: string | null;
  selectedLabel: string | null;
  selectedMode: Types.AcpSessionMode | null;
  pendingValue: string | null;
  isSetting: boolean;
  draftModes: Types.AcpSessionModeState | null;

  // Methods
  handleModeChange: (value: string) => Promise<void>;
}

// ============================================================================
// Helper Functions (private)
// ============================================================================

function modeDisplayLabel(mode: Pick<Types.AcpSessionMode, 'id' | 'name'>): string {
  return mode.name?.trim() || mode.id?.trim() || 'Mode';
}

function readJsonStorage<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJsonStorage<T>(key: string, value: T) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore cache persistence failures
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useModeSelector(options: UseModeSelectorOptions = {}): UseModeSelectorReturn {
  const { enabled = true, onNotice } = options;

  const {
    activeConversationId,
    activeAgentProfileId,
    activeWorkspace,
    activeConversationState,
    setMode,
  } = useAppStore();

  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [isSetting, setIsSetting] = useState(false);
  const [draftModes, setDraftModes] = useState<Types.AcpSessionModeState | null>(null);

  // Load draft modes for new conversations (mirrors App.tsx logic)
  useEffect(() => {
    if (!enabled || activeConversationId || !activeWorkspace || !activeAgentProfileId) return;

    const cachedModes =
      readJsonStorage<Record<string, Types.AcpSessionModeState | null>>(STORAGE_KEYS.MODE_CACHE)?.[
        activeAgentProfileId
      ] ?? null;
    setDraftModes(cachedModes);

    let cancelled = false;
    void API.previewSessionConfig({
      workspace_id: activeWorkspace.id,
      agent_profile_id: activeAgentProfileId,
    })
      .then((result) => {
        if (cancelled) return;
        if (result.modes?.available_modes?.length) {
          setDraftModes(result.modes ?? null);
          const nextModesCache = {
            ...(readJsonStorage<Record<string, Types.AcpSessionModeState | null>>(
              STORAGE_KEYS.MODE_CACHE
            ) ?? {}),
            [activeAgentProfileId]: result.modes ?? null,
          };
          writeJsonStorage(STORAGE_KEYS.MODE_CACHE, nextModesCache);
        }
      })
      .catch((error) => {
        console.error('Failed to preview session config', error);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, activeConversationId, activeWorkspace, activeAgentProfileId]);

  // Compute activeModeState
  const activeModeState = activeConversationId ? activeConversationState?.modes ?? null : draftModes;

  // Compute selectedValue (priority: pending > session > draft > null)
  const draftModeSelections =
    readJsonStorage<Record<string, { value: string }>>(STORAGE_KEYS.MODE_SELECTION_CACHE) ?? {};
  const draftSelectedValue =
    !activeConversationId && activeAgentProfileId ? draftModeSelections[activeAgentProfileId]?.value ?? null : null;
  const selectedValue =
    pendingValue ??
    (activeConversationId ? activeModeState?.current_mode_id : draftSelectedValue) ??
    activeModeState?.current_mode_id ??
    null;

  // Compute selectedMode and selectedLabel
  const selectedMode = activeModeState?.available_modes?.find((m) => m.id === selectedValue) ?? null;
  const selectedLabel = selectedMode ? modeDisplayLabel(selectedMode) : selectedValue;

  // Handle mode change
  const handleModeChange = async (value: string) => {
    if (isSetting || value === selectedValue || !activeModeState) return;

    if (!activeConversationId) {
      if (!activeAgentProfileId) return;
      const nextSelections = {
        ...draftModeSelections,
        [activeAgentProfileId]: { value },
      };
      writeJsonStorage(STORAGE_KEYS.MODE_SELECTION_CACHE, nextSelections);
      setPendingValue(value);
      window.setTimeout(() => setPendingValue(null), 0);
      return;
    }

    const previousValue = selectedValue;
    setPendingValue(value);
    setIsSetting(true);
    onNotice?.(null);
    try {
      await setMode(value);
    } catch (error) {
      console.error('Failed to set mode', error);
      setPendingValue(previousValue);
      onNotice?.('Failed to switch mode.');
    } finally {
      setIsSetting(false);
      setPendingValue(null);
    }
  };

  return {
    activeModeState,
    selectedValue,
    selectedLabel,
    selectedMode,
    pendingValue,
    isSetting,
    draftModes,
    handleModeChange,
  };
}
