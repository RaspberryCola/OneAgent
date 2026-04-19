import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '../lib/store';
import * as API from '../lib/backend/commands';
import * as Types from '../lib/backend/types';
import { STORAGE_KEYS } from '../lib/constants';

// ============================================================================
// Types
// ============================================================================

export type ModelChoice = {
  value: string;
  label: string;
  supportsVision?: boolean | null;
};

export type ModelSelectorState = {
  option: Types.SessionConfigOption;
  choices: ModelChoice[];
  selectedValue: string | null;
  selectedLabel: string | null;
};

export interface UseModelSelectorOptions {
  enabled?: boolean;
  onNotice?: (message: string | null) => void;
}

export interface UseModelSelectorReturn {
  modelSelector: ModelSelectorState | null;
  selectedValue: string;
  selectedLabel: string | null;
  pendingValue: string | null;
  isSetting: boolean;
  draftConfigOptions: Types.SessionConfigOption[];
  draftModels: Types.AcpSessionModels | null;
  handleModelChange: (value: string) => Promise<void>;
  clearPendingValue: () => void;
}

// ============================================================================
// Helper Functions (private)
// ============================================================================

function optionChoices(option: Types.SessionConfigOption): ModelChoice[] {
  if (Array.isArray(option.options)) {
    return option.options.map((item: any) => {
      if (typeof item === 'object' && item !== null) {
        return {
          value: item.value ?? item.id ?? item.key ?? item.name ?? '',
          label: item.label ?? item.name ?? String(item.value ?? item.id ?? item.key ?? ''),
          supportsVision: inferVisionSupport(item),
        };
      }
      return { value: item, label: String(item) };
    });
  }
  return [];
}

function isImageCapableModality(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return normalized.includes('image')
    || normalized.includes('vision')
    || normalized.includes('multimodal')
    || normalized.includes('multi-modal');
}

function inferVisionSupport(raw: any): boolean | null {
  if (!raw || typeof raw !== 'object') return null;
  const directFlags = [
    raw.supportsVision,
    raw.vision,
    raw.isVision,
    raw.multimodal,
    raw.supports_image_input,
    raw.supportsImageInput,
  ];
  for (const flag of directFlags) {
    if (typeof flag === 'boolean') return flag;
  }

  const modalityKeys = [
    raw.modalities,
    raw.inputModalities,
    raw.input_modalities,
    raw.supportedModalities,
    raw.supported_modalities,
  ];
  for (const modalities of modalityKeys) {
    if (Array.isArray(modalities)) {
      if (modalities.some(isImageCapableModality)) return true;
      if (modalities.every((item) => typeof item === 'string')) return false;
    }
  }

  if (raw.capabilities && typeof raw.capabilities === 'object') {
    const caps = raw.capabilities;
    if (typeof caps.vision === 'boolean') return caps.vision;
    if (typeof caps.image === 'boolean') return caps.image;
    if (typeof caps.multimodal === 'boolean') return caps.multimodal;
  }

  return null;
}

function configOptionSelectedValue(option: Types.SessionConfigOption): string | null {
  const raw = option.raw ?? {};
  const selectedValueRaw =
    option.current_value ??
    raw.currentValue ??
    raw.selectedValue ??
    raw.value ??
    null;
  return selectedValueRaw === null || selectedValueRaw === undefined || selectedValueRaw === ''
    ? null
    : String(selectedValueRaw);
}

function modelChoiceId(model: Types.AcpAvailableModel): string {
  return model.id ?? model.model_id ?? '';
}

function buildModelSelectorState(
  configOptions: Types.SessionConfigOption[],
  models?: Types.AcpSessionModels | null
): ModelSelectorState | null {
  const modelOption = configOptions.find((option) => {
    const category = option.category?.toLowerCase() ?? '';
    return category === 'model' || option.id.toLowerCase().includes('model');
  });

  if (modelOption && modelOption.options && Array.isArray(modelOption.options) && modelOption.options.length > 0) {
    const choices = optionChoices(modelOption)
      .map((choice) => ({
        value: String(choice.value),
        label: String(choice.label || choice.value),
      }))
      .filter((choice, index, array) => array.findIndex((item) => item.value === choice.value) === index);

    const configSelectedValue = configOptionSelectedValue(modelOption);
    const modelSelectedValue = models?.current_model_id ? String(models.current_model_id) : null;
    const selectedValue =
      modelSelectedValue && choices.some((choice) => choice.value === modelSelectedValue)
        ? modelSelectedValue
        : configSelectedValue;
    const selectedLabel =
      choices.find((choice) => choice.value === selectedValue)?.label ??
      (selectedValue
        ? models?.available_models?.find((model) => modelChoiceId(model) === selectedValue)?.name ??
          String((modelOption.raw ?? {}).currentLabel ?? (modelOption.raw ?? {}).selectedLabel ?? selectedValue)
        : null);

    return {
      option: modelOption,
      choices,
      selectedValue,
      selectedLabel,
    };
  }

  if (models && models.available_models && models.available_models.length > 0) {
    const choices = models.available_models
      .map((model) => ({
        value: model.id ?? model.model_id ?? '',
        label: model.name ?? model.id ?? model.model_id ?? '',
        supportsVision: inferVisionSupport(model.raw ?? model),
      }))
      .filter((choice) => choice.value !== '');

    const currentModelId = models.current_model_id ?? null;
    const selectedLabel = choices.find((c) => c.value === currentModelId)?.label ?? currentModelId;

    return {
      option: {
        id: 'model',
        name: 'Model',
        option_type: 'select',
        current_value: currentModelId,
        options: [],
        raw: {},
      },
      choices,
      selectedValue: currentModelId,
      selectedLabel,
    };
  }

  return null;
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
    // Ignore cache persistence failures.
  }
}

// ============================================================================
// Hook
// ============================================================================

export function useModelSelector(options: UseModelSelectorOptions = {}): UseModelSelectorReturn {
  const { enabled = true, onNotice } = options;

  const {
    activeConversationId,
    activeAgentProfileId,
    activeWorkspace,
    activeConversationState,
    setSessionConfig,
  } = useAppStore();

  const [pendingValue, setPendingValue] = useState<string | null>(null);
  const [isSetting, setIsSetting] = useState(false);
  const [draftConfigOptions, setDraftConfigOptions] = useState<Types.SessionConfigOption[]>([]);
  const [draftModels, setDraftModels] = useState<Types.AcpSessionModels | null>(null);

  useEffect(() => {
    if (!enabled || activeConversationId || !activeWorkspace || !activeAgentProfileId) return;

    const cachedConfig =
      readJsonStorage<Record<string, Types.SessionConfigOption[]>>(STORAGE_KEYS.MODEL_CONFIG_CACHE)?.[
        activeAgentProfileId
      ] ?? [];
    const cachedModels =
      readJsonStorage<Record<string, Types.AcpSessionModels | null>>(STORAGE_KEYS.MODEL_MODELS_CACHE)?.[
        activeAgentProfileId
      ] ?? null;

    setDraftConfigOptions(cachedConfig);
    setDraftModels(cachedModels);

    let cancelled = false;
    void API.previewSessionConfig({
      workspace_id: activeWorkspace.id,
      agent_profile_id: activeAgentProfileId,
    })
      .then((result) => {
        if (cancelled) return;
        if (
          result.config_options.length > 0 ||
          result.models?.available_models?.length ||
          result.modes?.available_modes?.length
        ) {
          setDraftConfigOptions(result.config_options);
          setDraftModels(result.models ?? null);
          const nextConfigCache = {
            ...(readJsonStorage<Record<string, Types.SessionConfigOption[]>>(
              STORAGE_KEYS.MODEL_CONFIG_CACHE
            ) ?? {}),
            [activeAgentProfileId]: result.config_options,
          };
          writeJsonStorage(STORAGE_KEYS.MODEL_CONFIG_CACHE, nextConfigCache);
          if (result.models) {
            const nextModelsCache = {
              ...(readJsonStorage<Record<string, Types.AcpSessionModels | null>>(
                STORAGE_KEYS.MODEL_MODELS_CACHE
              ) ?? {}),
              [activeAgentProfileId]: result.models,
            };
            writeJsonStorage(STORAGE_KEYS.MODEL_MODELS_CACHE, nextModelsCache);
          }
        }
      })
      .catch((error) => {
        console.error('Failed to preview session config', error);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, activeConversationId, activeWorkspace, activeAgentProfileId]);

  const conversationModelSelector = useMemo(
    () => buildModelSelectorState(activeConversationState?.config_options ?? [], activeConversationState?.models),
    [activeConversationState?.config_options, activeConversationState?.models]
  );

  const draftModelSelector = useMemo(
    () => buildModelSelectorState(draftConfigOptions, draftModels),
    [draftConfigOptions, draftModels]
  );

  const modelSelector = activeConversationId ? conversationModelSelector : draftModelSelector;

  const draftSelections =
    readJsonStorage<Record<string, { configId: string; value: string }>>(STORAGE_KEYS.MODEL_SELECTION_CACHE) ?? {};
  const draftSelectedValue =
    !activeConversationId && activeAgentProfileId ? draftSelections[activeAgentProfileId]?.value ?? null : null;
  const normalizedDraftSelectedValue =
    draftSelectedValue && modelSelector?.choices.some((choice) => choice.value === draftSelectedValue)
      ? draftSelectedValue
      : null;
  const selectedValue =
    pendingValue ??
    (activeConversationId
      ? modelSelector?.selectedValue ?? ''
      : normalizedDraftSelectedValue ?? modelSelector?.selectedValue ?? '');

  const selectedLabel =
    modelSelector?.choices.find((choice) => choice.value === selectedValue)?.label ??
    modelSelector?.selectedLabel ??
    null;

  const handleModelChange = async (value: string) => {
    if (!modelSelector || isSetting || value === selectedValue) return;

    if (!activeConversationId) {
      if (!activeAgentProfileId) return;
      const nextSelections = {
        ...(readJsonStorage<Record<string, { configId: string; value: string }>>(
          STORAGE_KEYS.MODEL_SELECTION_CACHE
        ) ?? {}),
        [activeAgentProfileId]: {
          configId: modelSelector.option.id,
          value,
        },
      };
      writeJsonStorage(STORAGE_KEYS.MODEL_SELECTION_CACHE, nextSelections);
      setPendingValue(value);
      window.setTimeout(() => setPendingValue(null), 0);
      return;
    }

    const previousValue = selectedValue ? String(selectedValue) : null;
    setPendingValue(value);
    setIsSetting(true);
    onNotice?.(null);
    try {
      await setSessionConfig(modelSelector.option.id, value);
    } catch (error) {
      console.error('Failed to set model', error);
      setPendingValue(previousValue);
      onNotice?.('Failed to switch model.');
    } finally {
      setIsSetting(false);
      setPendingValue(null);
    }
  };

  const clearPendingValue = () => setPendingValue(null);

  return {
    modelSelector,
    selectedValue,
    selectedLabel,
    pendingValue,
    isSetting,
    draftConfigOptions,
    draftModels,
    handleModelChange,
    clearPendingValue,
  };
}
