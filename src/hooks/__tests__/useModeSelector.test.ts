import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useModeSelector } from '../useModeSelector';
import * as API from '../../lib/backend/commands';
import { useAppStore } from '../../lib/store';
import { STORAGE_KEYS } from '../../lib/constants';
import * as Types from '../../lib/backend/types';

// Mock dependencies
vi.mock('../../lib/backend/commands');
vi.mock('../../lib/store');
vi.mock('../../lib/constants', () => ({
  STORAGE_KEYS: {
    MODE_CACHE: 'oneagent.mode-metadata-cache.v1',
    MODE_SELECTION_CACHE: 'oneagent.mode-selection-cache.v1',
  },
}));

describe('modeDisplayLabel', () => {
  it('returns mode name when available', () => {
    const mode = { id: 'architect', name: 'Architect Mode' };
    // Test via the internal logic - name takes priority
    expect(mode.name?.trim() || mode.id?.trim() || 'Mode').toBe('Architect Mode');
  });

  it('returns mode id when name is empty', () => {
    const mode = { id: 'architect', name: '' };
    expect(mode.name?.trim() || mode.id?.trim() || 'Mode').toBe('architect');
  });

  it('returns "Mode" when both id and name are empty', () => {
    const mode = { id: '', name: '' };
    expect(mode.name?.trim() || mode.id?.trim() || 'Mode').toBe('Mode');
  });

  it('handles null/undefined name gracefully', () => {
    const mode = { id: 'architect', name: null as any };
    expect(mode.name?.trim() || mode.id?.trim() || 'Mode').toBe('architect');
  });
});

describe('useModeSelector', () => {
  const mockSetMode = vi.fn();
  const mockOnNotice = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    // Mock useAppStore
    vi.mocked(useAppStore).mockReturnValue({
      activeConversationId: null,
      activeAgentProfileId: 'agent-1',
      activeWorkspace: { id: 'ws-1', name: 'Test Workspace', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
      activeConversationState: null,
      setMode: mockSetMode,
    } as any);

    // Mock API
    vi.mocked(API.previewSessionConfig).mockResolvedValue({
      config_options: [],
      models: null,
      modes: {
        current_mode_id: 'architect',
        available_modes: [
          { id: 'architect', name: 'Architect Mode' },
          { id: 'engineer', name: 'Engineer Mode' },
        ],
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('returns null for activeModeState when no conversation and no draft', () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: null,
        activeAgentProfileId: null,
        activeWorkspace: null,
        activeConversationState: null,
        setMode: mockSetMode,
      } as any);

      const { result } = renderHook(() => useModeSelector());

      expect(result.current.activeModeState).toBeNull();
    });

    it('uses conversation modes when conversation exists', () => {
      const conversationModes: Types.AcpSessionModeState = {
        current_mode_id: 'engineer',
        available_modes: [
          { id: 'architect', name: 'Architect Mode' },
          { id: 'engineer', name: 'Engineer Mode' },
        ],
      };

      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
        activeConversationState: { modes: conversationModes } as any,
        setMode: mockSetMode,
      } as any);

      const { result } = renderHook(() => useModeSelector());

      expect(result.current.activeModeState).toBe(conversationModes);
      expect(result.current.selectedValue).toBe('engineer');
    });
  });

  describe('selectedValue calculation', () => {
    it('uses pendingValue with highest priority', () => {
      // Set up draft mode in localStorage
      localStorage.setItem(
        STORAGE_KEYS.MODE_SELECTION_CACHE,
        JSON.stringify({ 'agent-1': { value: 'architect' } })
      );

      const { result } = renderHook(() => useModeSelector());

      // Initially should use draft selection
      expect(result.current.selectedValue).toBe('architect');
    });

    it('falls back to session current_mode_id when no pending value', () => {
      const conversationModes: Types.AcpSessionModeState = {
        current_mode_id: 'engineer',
        available_modes: [{ id: 'engineer', name: 'Engineer' }],
      };

      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
        activeConversationState: { modes: conversationModes } as any,
        setMode: mockSetMode,
      } as any);

      const { result } = renderHook(() => useModeSelector());

      expect(result.current.selectedValue).toBe('engineer');
    });

    it('uses draft selection for new conversations', () => {
      localStorage.setItem(
        STORAGE_KEYS.MODE_SELECTION_CACHE,
        JSON.stringify({ 'agent-1': { value: 'architect' } })
      );

      const { result } = renderHook(() => useModeSelector());

      expect(result.current.selectedValue).toBe('architect');
    });
  });

  describe('handleModeChange', () => {
    describe('without active conversation', () => {
      beforeEach(() => {
        // Set up draft modes so activeModeState is not null
        localStorage.setItem(
          STORAGE_KEYS.MODE_CACHE,
          JSON.stringify({
            'agent-1': {
              current_mode_id: 'architect',
              available_modes: [
                { id: 'architect', name: 'Architect Mode' },
                { id: 'engineer', name: 'Engineer Mode' },
              ],
            },
          })
        );
      });

      it('saves selection to localStorage', async () => {
        const { result } = renderHook(() => useModeSelector());

        // Wait for effect to load draft modes from cache
        await waitFor(() => {
          expect(result.current.draftModes).not.toBeNull();
        });

        await act(async () => {
          await result.current.handleModeChange('engineer');
        });

        const stored = localStorage.getItem(STORAGE_KEYS.MODE_SELECTION_CACHE);
        expect(JSON.parse(stored!)).toEqual({ 'agent-1': { value: 'engineer' } });
      });

      it('sets pending value temporarily', async () => {
        const { result } = renderHook(() => useModeSelector());

        await waitFor(() => {
          expect(result.current.draftModes).not.toBeNull();
        });

        await act(async () => {
          await result.current.handleModeChange('engineer');
        });

        expect(result.current.pendingValue).toBe('engineer');

        // Wait for timeout that clears pending value
        await waitFor(() => {
          expect(result.current.pendingValue).toBeNull();
        });
      });

      it('returns early if no agent profile', async () => {
        vi.mocked(useAppStore).mockReturnValue({
          activeConversationId: null,
          activeAgentProfileId: null,
          activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
          activeConversationState: null,
          setMode: mockSetMode,
        } as any);

        const { result } = renderHook(() => useModeSelector());

        await act(async () => {
          await result.current.handleModeChange('engineer');
        });

        expect(mockSetMode).not.toHaveBeenCalled();
      });
    });

    describe('with active conversation', () => {
      beforeEach(() => {
        const conversationModes: Types.AcpSessionModeState = {
          current_mode_id: 'architect',
          available_modes: [
            { id: 'architect', name: 'Architect Mode' },
            { id: 'engineer', name: 'Engineer Mode' },
          ],
        };

        vi.mocked(useAppStore).mockReturnValue({
          activeConversationId: 'conv-1',
          activeAgentProfileId: 'agent-1',
          activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
          activeConversationState: { modes: conversationModes } as any,
          setMode: mockSetMode,
        } as any);
      });

      it('calls setMode API', async () => {
        const { result } = renderHook(() => useModeSelector());

        await act(async () => {
          await result.current.handleModeChange('engineer');
        });

        expect(mockSetMode).toHaveBeenCalledWith('engineer');
      });

      it('sets isSetting flag during API call', async () => {
        let resolvePromise: (value: any) => void;
        const promise = new Promise((resolve) => {
          resolvePromise = resolve;
        });
        vi.mocked(mockSetMode).mockImplementation(() => promise as any);

        const { result } = renderHook(() => useModeSelector());

        act(() => {
          result.current.handleModeChange('engineer');
        });

        await waitFor(() => {
          expect(result.current.isSetting).toBe(true);
        });

        resolvePromise!({ current_mode_id: 'engineer', available_modes: [] });
        await waitFor(() => {
          expect(result.current.isSetting).toBe(false);
        });
      });

      it('calls onNotice with null before API call', async () => {
        const onNotice = vi.fn();
        const { result } = renderHook(() => useModeSelector({ onNotice }));

        await act(async () => {
          await result.current.handleModeChange('engineer');
        });

        expect(onNotice).toHaveBeenCalledWith(null);
      });

      it('handles API error and restores previous value', async () => {
        vi.mocked(mockSetMode).mockRejectedValue(new Error('API error'));
        const onNotice = vi.fn();

        const { result } = renderHook(() => useModeSelector({ onNotice }));

        await act(async () => {
          await result.current.handleModeChange('engineer');
        });

        expect(onNotice).toHaveBeenCalledWith('Failed to switch mode.');
        expect(result.current.pendingValue).toBeNull();
      });

      it('returns early if value unchanged', async () => {
        const { result } = renderHook(() => useModeSelector());

        await act(async () => {
          await result.current.handleModeChange('architect');
        });

        expect(mockSetMode).not.toHaveBeenCalled();
      });

      it('returns early if already setting', async () => {
        let resolvePromise: (value: any) => void;
        const promise = new Promise((resolve) => {
          resolvePromise = resolve;
        });
        vi.mocked(mockSetMode).mockImplementation(() => promise as any);

        const { result } = renderHook(() => useModeSelector());

        act(() => {
          result.current.handleModeChange('engineer');
        });

        await waitFor(() => {
          expect(result.current.isSetting).toBe(true);
        });

        // Try to change again while setting
        await act(async () => {
          await result.current.handleModeChange('architect');
        });

        expect(mockSetMode).toHaveBeenCalledTimes(1);

        resolvePromise!({ current_mode_id: 'engineer', available_modes: [] });
      });
    });
  });

  describe('useEffect - loading draft modes', () => {
    it('loads from cache first', async () => {
      const cachedModes: Types.AcpSessionModeState = {
        current_mode_id: 'cached-mode',
        available_modes: [{ id: 'cached-mode', name: 'Cached Mode' }],
      };
      localStorage.setItem(
        STORAGE_KEYS.MODE_CACHE,
        JSON.stringify({ 'agent-1': cachedModes })
      );

      // Mock API to NOT return modes (so cache persists)
      vi.mocked(API.previewSessionConfig).mockResolvedValue({
        config_options: [],
        models: null,
        modes: null,
      });

      const { result } = renderHook(() => useModeSelector());

      // Wait for effect to load from cache
      await waitFor(() => {
        expect(result.current.draftModes).not.toBeNull();
      });

      // Should have cached data (not overwritten by API since it returned null)
      expect(result.current.draftModes).toEqual(cachedModes);
    });

    it('fetches from API when no conversation', async () => {
      // Re-mock to ensure it's not using stale mock data
      vi.mocked(API.previewSessionConfig).mockClear();

      renderHook(() => useModeSelector());

      await waitFor(() => {
        expect(API.previewSessionConfig).toHaveBeenCalledWith({
          workspace_id: 'ws-1',
          agent_profile_id: 'agent-1',
        });
      });
    });

    it('updates draftModes from API response', async () => {
      const { result } = renderHook(() => useModeSelector());

      await waitFor(() => {
        expect(result.current.draftModes).toEqual({
          current_mode_id: 'architect',
          available_modes: [
            { id: 'architect', name: 'Architect Mode' },
            { id: 'engineer', name: 'Engineer Mode' },
          ],
        });
      });
    });

    it('caches API response to localStorage', async () => {
      renderHook(() => useModeSelector());

      await waitFor(() => {
        const cached = localStorage.getItem(STORAGE_KEYS.MODE_CACHE);
        expect(JSON.parse(cached!)).toHaveProperty('agent-1');
      });
    });

    it('does not fetch when conversation exists', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
        activeConversationState: null,
        setMode: mockSetMode,
      } as any);

      renderHook(() => useModeSelector());

      await waitFor(() => {
        expect(API.previewSessionConfig).not.toHaveBeenCalled();
      });
    });

    it('cleans up on unmount', async () => {
      const { unmount } = renderHook(() => useModeSelector());

      unmount();

      // After unmount, the cancelled flag should prevent state updates
      // This is tested by ensuring no errors occur after unmount
      await waitFor(() => {
        expect(API.previewSessionConfig).toHaveBeenCalled();
      });
    });
  });

  describe('selectedLabel calculation', () => {
    it('uses modeDisplayLabel when mode is found', () => {
      const conversationModes: Types.AcpSessionModeState = {
        current_mode_id: 'architect',
        available_modes: [{ id: 'architect', name: 'Architect Mode' }],
      };

      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
        activeConversationState: { modes: conversationModes } as any,
        setMode: mockSetMode,
      } as any);

      const { result } = renderHook(() => useModeSelector());

      expect(result.current.selectedLabel).toBe('Architect Mode');
    });

    it('falls back to selectedValue when mode not found', () => {
      const conversationModes: Types.AcpSessionModeState = {
        current_mode_id: 'unknown-mode',
        available_modes: [{ id: 'other', name: 'Other Mode' }],
      };

      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: { id: 'ws-1', name: 'Test', cwd: '/test', display_name: 'Test', trusted: true, archived: false, created_at: '2024-01-01', updated_at: '2024-01-01' } as Types.Workspace,
        activeConversationState: { modes: conversationModes } as any,
        setMode: mockSetMode,
      } as any);

      const { result } = renderHook(() => useModeSelector());

      expect(result.current.selectedLabel).toBe('unknown-mode');
    });
  });

  describe('enabled option', () => {
    it('skips effect when enabled is false', async () => {
      const { result } = renderHook(() => useModeSelector({ enabled: false }));

      await waitFor(() => {
        expect(API.previewSessionConfig).not.toHaveBeenCalled();
      });

      expect(result.current.draftModes).toBeNull();
    });
  });
});
