import { useCallback, useMemo, useState } from 'react';
import type * as Types from '../lib/backend/types';
import type { AttachmentState } from './useAttachmentHandler';
import type { ModelSelectorState } from './useModelSelector';

export interface UseConversationComposerOptions {
  activeConversationId: string | null;
  activeAgentProfileId: string | null;
  isConversationBusy: boolean;
  canSendAttachments: boolean;
  blockedAttachment?: AttachmentState;
  isAddingAttachment: boolean;
  attachmentStates: AttachmentState[];
  resetAttachments: () => void;
  modelSelector: ModelSelectorState | null;
  selectedModelValue: string;
  activeModeState?: Types.AcpSessionModeState | null;
  selectedModeValue?: string | null;
  sendMessage: (
    text: string,
    attachments?: Types.AttachmentInput[],
    sessionConfigOverrides?: Array<{ config_id: string; value: any }>,
  ) => Promise<void>;
  cancelTurn: () => Promise<void>;
  setComposerNotice: (message: string | null) => void;
}

export interface UseConversationComposerReturn {
  input: string;
  setInput: (value: string) => void;
  isSending: boolean;
  canSend: boolean;
  isBusy: boolean;
  resetComposer: () => void;
  handleSend: () => Promise<void>;
  handleStop: () => Promise<void>;
  handleKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function useConversationComposer(options: UseConversationComposerOptions): UseConversationComposerReturn {
  const {
    activeConversationId,
    activeAgentProfileId,
    isConversationBusy,
    canSendAttachments,
    blockedAttachment,
    isAddingAttachment,
    attachmentStates,
    resetAttachments,
    modelSelector,
    selectedModelValue,
    activeModeState,
    selectedModeValue,
    sendMessage,
    cancelTurn,
    setComposerNotice,
  } = options;

  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);

  const canSend = useMemo(() => {
    return input.trim().length > 0
      && !!activeAgentProfileId
      && !blockedAttachment
      && !isAddingAttachment
      && canSendAttachments;
  }, [activeAgentProfileId, blockedAttachment, canSendAttachments, input, isAddingAttachment]);

  const isBusy = isSending || isConversationBusy;

  const resetComposer = useCallback(() => {
    resetAttachments();
    setInput('');
    setComposerNotice(null);
  }, [resetAttachments, setComposerNotice]);

  const handleSend = useCallback(async () => {
    if (!canSend || !activeAgentProfileId || isBusy) return;

    setIsSending(true);
    const payload: Types.AttachmentInput[] = attachmentStates.map(({ attachment, resolution }) => ({
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      mime_type: attachment.mimeType,
      kind: attachment.kind,
      delivery_preference: resolution.deliveryPreference,
    }));

    const text = input.trim();
    const sessionConfigOverrides: Array<{ config_id: string; value: any }> = [];

    if (!activeConversationId) {
      if (modelSelector && selectedModelValue && selectedModelValue !== modelSelector.selectedValue) {
        sessionConfigOverrides.push({ config_id: modelSelector.option.id, value: selectedModelValue });
      }
      if (activeModeState && selectedModeValue && selectedModeValue !== activeModeState.current_mode_id) {
        sessionConfigOverrides.push({ config_id: '__mode_override__', value: selectedModeValue });
      }
    }

    resetAttachments();
    setInput('');
    setComposerNotice(null);

    try {
      await sendMessage(text, payload, sessionConfigOverrides);
    } catch (error) {
      console.error('Failed to send message', error);
      setComposerNotice('Failed to send message.');
    } finally {
      setIsSending(false);
    }
  }, [
    activeAgentProfileId,
    activeConversationId,
    activeModeState,
    attachmentStates,
    canSend,
    input,
    isBusy,
    modelSelector,
    resetAttachments,
    selectedModeValue,
    selectedModelValue,
    sendMessage,
    setComposerNotice,
  ]);

  const handleStop = useCallback(async () => {
    await cancelTurn();
  }, [cancelTurn]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  return {
    input,
    setInput,
    isSending,
    canSend,
    isBusy,
    resetComposer,
    handleSend,
    handleStop,
    handleKeyDown,
  };
}
