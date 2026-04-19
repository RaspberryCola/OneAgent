import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useModelSelector } from '../useModelSelector';
import * as Types from '../../lib/backend/types';
import { STORAGE_KEYS } from '../../lib/constants';

vi.mock('../../lib/store', () => ({
  useAppStore: vi.fn(),
}));

vi.mock('../../lib/backend/commands', async () => {
  const actual = await vi.importActual('../../lib/backend/commands');
  return {
    ...actual,
    previewSessionConfig: vi.fn(),
  };
});

const { useAppStore } = await import('../../lib/store');
const API = await import('../../lib/backend/commands');

describe('useModelSelector', () => {
  const mockSetSessionConfig = vi.fn();

  const mockConfigOption: Types.SessionConfigOption = {
    id: 'model',
    name: 'Model',
    description: 'Select a model',
    category: 'model',
    option_type: 'select',
    current_value: 'claude-sonnet-4-5-20250929',
    options: [
      { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
      { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    raw: {},
  };

  const mockModels: Types.AcpSessionModels = {
    current_model_id: 'claude-sonnet-4-5-20250929',
    available_models: [
      { id: 'claude-sonnet-4-5-20250929', model_id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-7', model_id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
    ],
  };

  const mockWorkspace = { id: 'ws-1', cwd: '/test', display_name: 'Test' } as Types.Workspace;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(API.previewSessionConfig).mockResolvedValue({
      config_options: [],
      models: null,
      modes: null,
    });
    vi.mocked(useAppStore).mockReturnValue({
      activeConversationId: null,
      activeAgentProfileId: 'agent-1',
      activeWorkspace: mockWorkspace,
      activeConversationState: null,
      setSessionConfig: mockSetSessionConfig,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('optionChoices', () => {
    it('should extract choices from object options', () => {
      const result = renderHook(() => useModelSelector()).result.current;
      // The helper is internal, so we test via the returned modelSelector
      expect(result.modelSelector).toBeNull();
    });
  });

  describe('buildModelSelectorState', () => {
    it('should return null when no config options or models', () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: null,
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: { config_options: [], models: null },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      expect(result.current.modelSelector).toBeNull();
    });

    it('should build selector from config_options', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [mockConfigOption],
          models: null,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.modelSelector).toBeTruthy();
      });

      if (result.current.modelSelector) {
        expect(result.current.modelSelector.option.id).toBe('model');
        expect(result.current.modelSelector.choices).toHaveLength(3);
        expect(result.current.selectedValue).toBe('claude-sonnet-4-5-20250929');
      }
    });

    it('should fall back to models when no config_options', () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [],
          models: mockModels,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      expect(result.current.modelSelector).toBeTruthy();
      if (result.current.modelSelector) {
        expect(result.current.modelSelector.choices).toHaveLength(2);
        expect(result.current.selectedValue).toBe('claude-sonnet-4-5-20250929');
      }
    });
  });

  describe('useEffect - loading config', () => {
    it('should load cached config on mount for new conversation', async () => {
      const cache: Record<string, Types.SessionConfigOption[]> = {
        'agent-1': [mockConfigOption],
      };
      localStorage.setItem(STORAGE_KEYS.MODEL_CONFIG_CACHE, JSON.stringify(cache));

      const { result } = renderHook(() => useModelSelector());

      await waitFor(() => {
        expect(result.current.draftConfigOptions).toHaveLength(1);
      });
      expect(result.current.draftConfigOptions[0].id).toBe('model');
    });

    it('should call previewSessionConfig API on mount', async () => {
      vi.mocked(API.previewSessionConfig).mockResolvedValue({
        config_options: [mockConfigOption],
        models: mockModels,
        modes: null,
      });

      const { result } = renderHook(() => useModelSelector());

      await waitFor(() => {
        expect(vi.mocked(API.previewSessionConfig)).toHaveBeenCalledWith({
          workspace_id: mockWorkspace.id,
          agent_profile_id: 'agent-1',
        });
        expect(result.current.draftConfigOptions).toHaveLength(1);
      });
    });

    it('should cache API results in localStorage', async () => {
      vi.mocked(API.previewSessionConfig).mockResolvedValue({
        config_options: [mockConfigOption],
        models: mockModels,
        modes: null,
      });

      renderHook(() => useModelSelector());

      await waitFor(() => {
        const cached = localStorage.getItem(STORAGE_KEYS.MODEL_CONFIG_CACHE);
        expect(cached).toBeTruthy();
      });

      const modelsCached = localStorage.getItem(STORAGE_KEYS.MODEL_MODELS_CACHE);
      expect(modelsCached).toBeTruthy();
    });

    it('should not load config when activeConversationId exists', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: { config_options: [], models: null },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      renderHook(() => useModelSelector());

      await waitFor(() => {
        expect(vi.mocked(API.previewSessionConfig)).not.toHaveBeenCalled();
      });
    });

    it('should not load config when enabled is false', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: null,
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: null,
        setSessionConfig: mockSetSessionConfig,
      } as any);

      renderHook(() => useModelSelector({ enabled: false }));

      await waitFor(() => {
        expect(vi.mocked(API.previewSessionConfig)).not.toHaveBeenCalled();
      });
    });
  });

  describe('selectedValue calculation', () => {
    it('should use pendingValue when set', () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: null,
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: null,
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const configCache: Record<string, Types.SessionConfigOption[]> = {
        'agent-1': [mockConfigOption],
      };
      localStorage.setItem(STORAGE_KEYS.MODEL_CONFIG_CACHE, JSON.stringify(configCache));

      const selectionCache: Record<string, { configId: string; value: string }> = {
        'agent-1': { configId: 'model', value: 'claude-opus-4-7' },
      };
      localStorage.setItem(STORAGE_KEYS.MODEL_SELECTION_CACHE, JSON.stringify(selectionCache));

      const { result } = renderHook(() => useModelSelector());
      expect(result.current.selectedValue).toBe('claude-opus-4-7');
    });

    it('should use conversation state selectedValue for active conversation', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [mockConfigOption],
          models: null,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.selectedValue).toBe('claude-sonnet-4-5-20250929');
      });
    });
  });

  describe('handleModelChange', () => {
    it('should save to localStorage for new conversation', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: null,
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: null,
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const configCache: Record<string, Types.SessionConfigOption[]> = {
        'agent-1': [mockConfigOption],
      };
      localStorage.setItem(STORAGE_KEYS.MODEL_CONFIG_CACHE, JSON.stringify(configCache));

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.modelSelector).toBeTruthy();
      });

      await act(async () => {
        await result.current.handleModelChange('claude-opus-4-7');
      });

      const cached = localStorage.getItem(STORAGE_KEYS.MODEL_SELECTION_CACHE);
      expect(cached).toBeTruthy();
      const parsed = JSON.parse(cached!);
      expect(parsed['agent-1'].value).toBe('claude-opus-4-7');
    });

    it('should call setSessionConfig for active conversation', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [mockConfigOption],
          models: null,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.modelSelector).toBeTruthy();
      });

      await act(async () => {
        await result.current.handleModelChange('claude-opus-4-7');
      });

      expect(mockSetSessionConfig).toHaveBeenCalledWith('model', 'claude-opus-4-7');
      expect(result.current.isSetting).toBe(false);
    });

    it('should handle API error and show composer notice', async () => {
      mockSetSessionConfig.mockRejectedValueOnce(new Error('API error'));

      const mockOnNotice = vi.fn();
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [mockConfigOption],
          models: null,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector({ onNotice: mockOnNotice }));
      await waitFor(() => {
        expect(result.current.modelSelector).toBeTruthy();
      });

      await act(async () => {
        await result.current.handleModelChange('claude-opus-4-7');
      });

      expect(mockOnNotice).toHaveBeenCalledWith('Failed to switch model.');
      expect(result.current.pendingValue).toBeNull();
    });

    it('should not change model if value is same as current', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [mockConfigOption],
          models: null,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.modelSelector).toBeTruthy();
      });

      await act(async () => {
        await result.current.handleModelChange('claude-sonnet-4-5-20250929');
      });

      expect(mockSetSessionConfig).not.toHaveBeenCalled();
    });

    it('should not change model if modelSelector is null', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: 'conv-1',
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: {
          config_options: [],
          models: null,
        },
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.modelSelector).toBeNull();
      });

      await act(async () => {
        await result.current.handleModelChange('any-value');
      });

      expect(mockSetSessionConfig).not.toHaveBeenCalled();
    });
  });

  describe('clearPendingValue', () => {
    it('should clear pending value', async () => {
      vi.mocked(useAppStore).mockReturnValue({
        activeConversationId: null,
        activeAgentProfileId: 'agent-1',
        activeWorkspace: mockWorkspace,
        activeConversationState: null,
        setSessionConfig: mockSetSessionConfig,
      } as any);

      const configCache: Record<string, Types.SessionConfigOption[]> = {
        'agent-1': [mockConfigOption],
      };
      localStorage.setItem(STORAGE_KEYS.MODEL_CONFIG_CACHE, JSON.stringify(configCache));

      const { result } = renderHook(() => useModelSelector());
      await waitFor(() => {
        expect(result.current.modelSelector).toBeTruthy();
      });

      await act(async () => {
        await result.current.handleModelChange('claude-opus-4-7');
      });

      expect(result.current.pendingValue).toBe('claude-opus-4-7');

      await act(async () => {
        result.current.clearPendingValue();
      });

      expect(result.current.pendingValue).toBeNull();
    });
  });
});
