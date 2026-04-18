import { useState, useRef, useCallback, useMemo } from 'react';
import * as API from '../lib/backend/commands';
import type * as Types from '../lib/backend/types';
import { ATTACHMENT_LIMITS } from '../lib/constants';

export type LocalAttachment = {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  kind: Types.AttachmentInput['kind'];
  size: number;
  source: 'picker' | 'drag' | 'paste';
  previewUrl?: string;
};

export type AttachmentResolution = {
  canSend: boolean;
  mode: 'image' | 'audio' | 'resource' | 'resource_link' | 'blocked' | 'probing';
  label: string;
  reason?: string;
  deliveryPreference: Types.AttachmentInput['delivery_preference'];
};

export interface UseAttachmentHandlerOptions {
  agentProfileId: string | null;
  capabilities: Types.AgentCapabilities | null | undefined;
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
  handleFileInput: (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDrop: (event: React.DragEvent<HTMLDivElement>) => Promise<void>;
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
  if (attachment.kind === 'image' && prompt.image && attachment.size <= ATTACHMENT_LIMITS.MAX_EMBEDDED_MEDIA_BYTES) {
    return { canSend: true, mode: 'image', label: 'Will send as image', deliveryPreference: 'embedded' };
  }
  if (attachment.kind === 'audio' && prompt.audio && attachment.size <= ATTACHMENT_LIMITS.MAX_EMBEDDED_MEDIA_BYTES) {
    return { canSend: true, mode: 'audio', label: 'Will send as audio', deliveryPreference: 'embedded' };
  }
  if (
    attachment.kind === 'file' &&
    prompt.embedded_context &&
    isTextLikeMime(attachment.mimeType) &&
    attachment.size <= ATTACHMENT_LIMITS.MAX_EMBEDDED_TEXT_BYTES
  ) {
    return { canSend: true, mode: 'resource', label: 'Will embed file contents', deliveryPreference: 'embedded' };
  }
  if (prompt.resource_link) {
    return { canSend: true, mode: 'resource_link', label: 'Will send as file reference', deliveryPreference: 'resource_link' };
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
    id: crypto.randomUUID(),
    name: file.name,
    path,
    mimeType,
    kind: inferAttachmentKind(mimeType),
    size: file.size,
    source,
    previewUrl: mimeType.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  };
}

/**
 * 自定义 Hook 用于处理附件添加、移除和解析
 */
export function useAttachmentHandler(options: UseAttachmentHandlerOptions): UseAttachmentHandlerReturn {
  const { agentProfileId, capabilities, onError, onNotice } = options;
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
      // Note: ensureAgentCapabilities should be passed from outside
      // For now, we use the capabilities directly from options
      if (!capabilities?.prompt_capabilities) {
        onNotice?.('This agent has not returned ACP prompt capabilities yet.');
        return;
      }
      const next = await Promise.all(Array.from(files).map((file) => materializeAttachment(file, source)));
      setAttachments((current) => [...current, ...next]);
      onNotice?.(null);
    } catch (error) {
      console.error('Failed to add attachments', error);
      onNotice?.('Failed to process one or more attachments.');
    } finally {
      setIsAddingAttachment(false);
    }
  }, [agentProfileId, capabilities, onNotice]);

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

  const handleDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
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

  const attachmentStates: AttachmentState[] = useMemo(() => {
    return attachments.map((attachment) => ({
      attachment,
      resolution: resolveAttachment(attachment, capabilities),
    }));
  }, [attachments, capabilities]);

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
    handleFileInput,
    handleDrop,
    handlePaste,
    resetAttachments,
    fileInputRef,
  };
}
