import { useState, useRef, useCallback, useMemo } from 'react';
import * as API from '../lib/backend/commands';
import type * as Types from '../lib/backend/types';
import { ATTACHMENT_LIMITS } from '../lib/constants';
import { randomId } from '../lib/utils/randomId';

export type LocalAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  kind: Types.AttachmentInput['kind'];
  usageIntent: Types.AttachmentInput['usage_intent'];
  size: number;
  source: 'picker' | 'drag' | 'paste';
  previewUrl?: string;
};

export type AttachmentResolution = {
  canSend: boolean;
  mode: 'image' | 'audio' | 'resource' | 'resource_link' | 'fallback_text_path' | 'blocked' | 'probing';
  label: string;
  reason?: string;
  deliveryPreference: Types.AttachmentInput['delivery_preference'];
};

export interface UseAttachmentHandlerOptions {
  agentProfileId: string | null;
  capabilities: Types.AgentCapabilities | null | undefined;
  adapterKind?: 'acp' | 'compat' | null;
  onError?: (message: string) => void;
  onNotice?: (message: string | null) => void;
}

export interface AttachmentState {
  attachment: LocalAttachment;
  resolution: AttachmentResolution;
}

export interface UseAttachmentHandlerReturn {
  // State
  attachments: LocalAttachment[];
  isAddingAttachment: boolean;
  attachmentStates: AttachmentState[];
  blockedAttachment?: AttachmentState;
  canSend: boolean;

  // Methods
  addFiles: (files: FileList | File[], source: LocalAttachment['source']) => Promise<void>;
  removeAttachment: (id: string) => void;
  setAttachmentUsageIntent: (id: string, usageIntent: Types.AttachmentInput['usage_intent']) => void;
  handleFileInput: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDrop: (event: React.DragEvent<HTMLElement>) => Promise<void>;
  handlePaste: (event: React.ClipboardEvent) => Promise<void>;
  resetAttachments: () => void;

  // Refs
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}

function inferAttachmentKind(mimeType: string): Types.AttachmentInput['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

function isTextLikeMime(mimeType: string) {
  return (
    mimeType.startsWith('text/') ||
    [
      'application/json',
      'application/xml',
      'application/javascript',
      'application/x-javascript',
      'application/typescript',
      'application/yaml',
      'application/x-yaml',
    ].includes(mimeType)
  );
}

function resolveAttachment(
  attachment: LocalAttachment,
  capabilities: Types.AgentCapabilities | null | undefined,
  adapterKind?: 'acp' | 'compat' | null,
): AttachmentResolution {
  if (!capabilities?.prompt_capabilities) {
    return {
      canSend: false,
      mode: 'probing',
      label: 'Need capability probe',
      reason: 'Probe the agent before sending attachments.',
      deliveryPreference: 'auto',
    };
  }

  const prompt = capabilities.prompt_capabilities;
  if (attachment.kind === 'image') {
    if (attachment.usageIntent === 'file_resource') {
      if (prompt.resource_link) {
        return { canSend: true, mode: 'resource_link', label: 'Will send as file reference', deliveryPreference: 'resource_link' };
      }
      if (prompt.text) {
        return {
          canSend: true,
          mode: 'fallback_text_path',
          label: 'Will send as text path hint',
          reason: 'Agent does not support structured file references; using text path fallback.',
          deliveryPreference: 'auto',
        };
      }
      return {
        canSend: false,
        mode: 'blocked',
        label: 'Unsupported by agent',
        reason: 'This agent cannot accept image attachments as file references.',
        deliveryPreference: 'auto',
      };
    }

    if (prompt.image && attachment.size <= ATTACHMENT_LIMITS.MAX_EMBEDDED_MEDIA_BYTES) {
      return { canSend: true, mode: 'image', label: 'Will send as image input', deliveryPreference: 'embedded' };
    }
    if (prompt.resource_link) {
      return {
        canSend: true,
        mode: 'resource_link',
        label: 'Will send as file reference',
        reason: 'Agent does not support image input in this context.',
        deliveryPreference: 'resource_link',
      };
    }
    return {
      canSend: false,
      mode: 'blocked',
      label: 'Unsupported by agent',
      reason: 'This agent does not support image input or file references.',
      deliveryPreference: 'auto',
    };
  }

  if (attachment.kind === 'audio') {
    if (attachment.usageIntent === 'file_resource') {
      if (prompt.resource_link) {
        return { canSend: true, mode: 'resource_link', label: 'Will send as file reference', deliveryPreference: 'resource_link' };
      }
      if (prompt.text) {
        return {
          canSend: true,
          mode: 'fallback_text_path',
          label: 'Will send as text path hint',
          reason: 'Agent does not support structured file references; using text path fallback.',
          deliveryPreference: 'auto',
        };
      }
      return {
        canSend: false,
        mode: 'blocked',
        label: 'Unsupported by agent',
        reason: 'This agent cannot accept audio attachments as file references.',
        deliveryPreference: 'auto',
      };
    }

    if (prompt.audio && attachment.size <= ATTACHMENT_LIMITS.MAX_EMBEDDED_MEDIA_BYTES) {
      return { canSend: true, mode: 'audio', label: 'Will send as audio input', deliveryPreference: 'embedded' };
    }
    if (prompt.resource_link) {
      return {
        canSend: true,
        mode: 'resource_link',
        label: 'Will send as file reference',
        reason: 'Agent does not support audio input in this context.',
        deliveryPreference: 'resource_link',
      };
    }
    return {
      canSend: false,
      mode: 'blocked',
      label: 'Unsupported by agent',
      reason: 'This agent does not support audio input or file references.',
      deliveryPreference: 'auto',
    };
  }

  if (attachment.usageIntent !== 'file_resource'
    && prompt.embedded_context
    && isTextLikeMime(attachment.mimeType)
    && attachment.size <= ATTACHMENT_LIMITS.MAX_EMBEDDED_TEXT_BYTES) {
    return { canSend: true, mode: 'resource', label: 'Will embed file contents', deliveryPreference: 'embedded' };
  }
  if (prompt.resource_link) {
    return { canSend: true, mode: 'resource_link', label: 'Will send as file reference', deliveryPreference: 'resource_link' };
  }
  if (prompt.text) {
    return {
      canSend: true,
      mode: 'fallback_text_path',
      label: 'Will send as text path hint',
      reason: adapterKind === 'compat'
        ? 'Adapter does not support structured attachments; using compatibility fallback.'
        : 'Agent does not support structured file references; using text path fallback.',
      deliveryPreference: 'auto',
    };
  }
  return {
    canSend: false,
    mode: 'blocked',
    label: 'Unsupported by agent',
    reason: 'This agent does not advertise a compatible attachment mode.',
    deliveryPreference: 'auto',
  };
}

async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.split(',')[1] ?? '');
    };
    reader.readAsDataURL(file);
  });
}

async function materializeAttachment(file: File, source: LocalAttachment['source']): Promise<LocalAttachment> {
  let path = ((file as any).path as string | undefined) ?? '';
  if (!path) {
    const base64 = await readFileAsBase64(file);
    const persisted = await API.persistAttachmentBlob({
      name: file.name,
      mime_type: file.type || null,
      base64_data: base64,
    });
    path = persisted.path;
  }
  const mimeType = file.type || 'application/octet-stream';
  return {
    id: randomId(),
    name: file.name,
    path,
    mimeType,
    kind: inferAttachmentKind(mimeType),
    usageIntent: 'auto',
    size: file.size,
    source,
    previewUrl: mimeType.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  };
}

/**
 * 自定义 Hook 用于处理附件添加、移除和解析
 */
export function useAttachmentHandler(options: UseAttachmentHandlerOptions): UseAttachmentHandlerReturn {
  const { agentProfileId, capabilities, adapterKind, onError, onNotice } = options;
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [isAddingAttachment, setIsAddingAttachment] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback(async (files: FileList | File[], source: LocalAttachment['source']) => {
    if (!agentProfileId) {
      onNotice?.('Select an agent before adding attachments.');
      return;
    }
    setIsAddingAttachment(true);
    try {
      const incoming = Array.from(files);
      const existingKeys = new Set(attachments.map((attachment) => `${attachment.path}|${attachment.name}|${attachment.size}|${attachment.mimeType}`));
      const next: LocalAttachment[] = [];
      const failures: string[] = [];
      let skippedAsDuplicate = 0;

      for (const file of incoming) {
        if (file.size > ATTACHMENT_LIMITS.MAX_UPLOAD_BYTES) {
          failures.push(`${file.name}: file is larger than ${Math.round(ATTACHMENT_LIMITS.MAX_UPLOAD_BYTES / (1024 * 1024))} MB`);
          continue;
        }
        const rawPath = ((file as any).path as string | undefined) ?? '';
        const mimeType = file.type || 'application/octet-stream';
        const dedupeKey = `${rawPath}|${file.name}|${file.size}|${mimeType}`;
        if (existingKeys.has(dedupeKey)) {
          skippedAsDuplicate += 1;
          continue;
        }

        try {
          const attachment = await materializeAttachment(file, source);
          const persistedKey = `${attachment.path}|${attachment.name}|${attachment.size}|${attachment.mimeType}`;
          if (existingKeys.has(persistedKey)) {
            if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
            skippedAsDuplicate += 1;
            continue;
          }
          existingKeys.add(persistedKey);
          next.push(attachment);
        } catch (error) {
          console.error('Failed to materialize attachment', file.name, error);
          failures.push(`${file.name}: failed to persist attachment`);
        }
      }

      if (next.length > 0) {
        setAttachments((current) => [...current, ...next]);
      }

      if (failures.length > 0) {
        onNotice?.(`Some files were skipped: ${failures.slice(0, 2).join('; ')}${failures.length > 2 ? ` (+${failures.length - 2} more)` : ''}`);
      } else if (skippedAsDuplicate > 0) {
        onNotice?.(`${skippedAsDuplicate} duplicate attachment${skippedAsDuplicate > 1 ? 's were' : ' was'} skipped.`);
      } else if (!capabilities?.prompt_capabilities && next.length > 0) {
        onNotice?.('Attachments added. Waiting for capability probe before send.');
      } else {
        onNotice?.(null);
      }
    } catch (error) {
      console.error('Failed to add attachments', error);
      onError?.('Failed to process one or more attachments.');
      onNotice?.('Failed to process one or more attachments.');
    } finally {
      setIsAddingAttachment(false);
    }
  }, [agentProfileId, attachments, capabilities?.prompt_capabilities, onError, onNotice]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handleFileInput = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) {
      await addFiles(event.target.files, 'picker');
    }
    event.target.value = '';
  }, [addFiles]);

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files?.length) {
      await addFiles(event.dataTransfer.files, 'drag');
    }
  }, [addFiles]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files ?? []);
    if (files.length > 0) {
      event.preventDefault();
      await addFiles(files, 'paste');
    }
  }, [addFiles]);

  const resetAttachments = useCallback(() => {
    attachments.forEach((attachment) => {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    });
    setAttachments([]);
  }, [attachments]);

  const setAttachmentUsageIntent = useCallback((id: string, usageIntent: Types.AttachmentInput['usage_intent']) => {
    setAttachments((current) => current.map((attachment) => {
      if (attachment.id !== id) return attachment;
      if (attachment.kind !== 'image' && usageIntent === 'vision_input') return attachment;
      return { ...attachment, usageIntent };
    }));
  }, []);

  const attachmentStates: AttachmentState[] = useMemo(() => {
    return attachments.map((attachment) => ({
      attachment,
      resolution: resolveAttachment(attachment, capabilities, adapterKind),
    }));
  }, [attachments, capabilities, adapterKind]);

  const blockedAttachment = useMemo(() => {
    return attachmentStates.find((entry) => !entry.resolution.canSend);
  }, [attachmentStates]);

  return {
    attachments,
    isAddingAttachment,
    attachmentStates,
    blockedAttachment,
    canSend: !blockedAttachment && !isAddingAttachment,
    addFiles,
    removeAttachment,
    setAttachmentUsageIntent,
    handleFileInput,
    handleDrop,
    handlePaste,
    resetAttachments,
    fileInputRef,
  };
}
