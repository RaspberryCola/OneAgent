import { useCallback, useMemo, useRef, useState } from 'react';
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
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
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
  // 使用 ref 同步跟踪 IME 状态，因为 React 状态更新是异步的
  // 在某些输入法中，keydown 事件可能在 compositionend 之前触发
  const isComposingRef = useRef(false);
  // 用于追踪 composition 刚结束的状态，防止紧接着的 Enter 发送消息
  const justEndedComposingRef = useRef(false);

  const canSend = useMemo(() => {
    const hasText = input.trim().length > 0;
    const hasAttachments = attachmentStates.length > 0;
    return (hasText || hasAttachments)
      && !!activeAgentProfileId
      && !blockedAttachment
      && !isAddingAttachment
      && canSendAttachments;
  }, [activeAgentProfileId, attachmentStates.length, blockedAttachment, canSendAttachments, input, isAddingAttachment]);

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
      usage_intent: attachment.usageIntent,
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

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    justEndedComposingRef.current = false;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    // 设置标记，防止紧接着的 Enter 发送消息
    justEndedComposingRef.current = true;
    // 短暂延迟后清除标记，让用户可以正常发送
    setTimeout(() => {
      justEndedComposingRef.current = false;
    }, 100);
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 使用 ref 同步检查 IME 状态，确保在 compositionend 触发前正确判断
    // 同时检查 composition 是否刚结束，防止在确认候选后立即发送
    const isImeComposing = event.nativeEvent.isComposing || isComposingRef.current || justEndedComposingRef.current;

    if (event.key === 'Enter' && !event.shiftKey && !isImeComposing) {
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
    handleCompositionStart,
    handleCompositionEnd,
  };
}
