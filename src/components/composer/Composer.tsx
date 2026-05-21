import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { motion } from 'framer-motion';
import type * as Types from '../../lib/backend/types';
import type {
  AttachmentResolution,
  LocalAttachment,
  ModelSelectorState,
} from '../../hooks';
import { AttachmentPreviewList } from './AttachmentPreviewList';
import { ModelSelectorMenu } from './ModelSelectorMenu';
import { ModeSelectorMenu } from './ModeSelectorMenu';

type ComposerProps = {
  input: string;
  setInput: (value: string) => void;
  attachments: Array<{ attachment: LocalAttachment; resolution: AttachmentResolution }>;
  activeAgent: Types.AgentProfile | null;
  modelSelector: ModelSelectorState | null;
  selectedModelValue: any;
  selectedModelLabel: string | null;
  onModelChange: (value: any) => void;
  isSettingModel: boolean;
  activeModeState?: Types.AcpSessionModeState | null;
  selectedModeValue?: any;
  selectedModeLabel?: string | null;
  onModeChange?: (value: any) => void;
  isSettingMode?: boolean;
  onAttachClick: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  onDragEnter?: (event: React.DragEvent<HTMLElement>) => void;
  onDragLeave?: (event: React.DragEvent<HTMLElement>) => void;
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onSetAttachmentUsageIntent: (id: string, usageIntent: 'vision_input' | 'file_resource') => void;
  onSend: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  canSend: boolean;
  isCompact: boolean;
  isBusy: boolean;
  onStop: () => void;
};

export function Composer({
  input,
  setInput,
  attachments,
  activeAgent,
  modelSelector,
  selectedModelValue,
  selectedModelLabel,
  onModelChange,
  isSettingModel,
  activeModeState,
  selectedModeValue,
  selectedModeLabel,
  onModeChange,
  isSettingMode,
  onAttachClick,
  onDrop,
  onDragEnter,
  onDragLeave,
  onPaste,
  onRemoveAttachment,
  onSetAttachmentUsageIntent,
  onSend,
  onKeyDown,
  canSend,
  isCompact,
  isBusy,
  onStop,
}: ComposerProps) {
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDropEvent = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);
    onDrop(event);
  };

  const handleDragEnterEvent = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
    onDragEnter?.(event);
  };

  const handleDragLeaveEvent = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
    onDragLeave?.(event);
  };

  const handleDragOverEvent = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  };

  const hasImages = attachments.some(a => a.attachment.kind === 'image');
  const isVisionMode = attachments.some(a => a.attachment.kind === 'image' && a.attachment.usageIntent === 'vision_input') || (hasImages && !attachments.some(a => a.attachment.kind === 'image' && a.attachment.usageIntent === 'file_resource'));

  const handleToggleVision = () => {
    const nextMode = isVisionMode ? 'file_resource' : 'vision_input';
    attachments.forEach(a => {
      if (a.attachment.kind === 'image') {
        onSetAttachmentUsageIntent(a.attachment.id, nextMode);
      }
    });
  };

  return (
    <div
      onDrop={handleDropEvent}
      onDragEnter={handleDragEnterEvent}
      onDragLeave={handleDragLeaveEvent}
      onDragOver={handleDragOverEvent}
      onDragEnd={() => {
        dragDepthRef.current = 0;
        setIsDragging(false);
      }}
      className={`w-full relative bg-pure-white border rounded-container transition-all flex flex-col group ${isDragging ? 'border-pure-black shadow-[0_0_0_2px_rgba(0,0,0,0.08)]' : 'border-light-gray'}`}
      data-active-agent={activeAgent?.id ?? ''}
    >
      <AttachmentPreviewList
        attachments={attachments}
        onRemoveAttachment={onRemoveAttachment}
        onSetUsageIntent={onSetAttachmentUsageIntent}
      />
      {isDragging && (
        <div className="px-3 pt-2 text-[11px] text-stone">Drop files to attach</div>
      )}

      <textarea
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDrop={handleDropEvent}
        onDragEnter={handleDragEnterEvent}
        onDragLeave={handleDragLeaveEvent}
        onDragOver={handleDragOverEvent}
        placeholder={isCompact ? 'Message...' : 'Message Agent...'}
        className={`w-full bg-transparent ${isCompact ? 'px-4 py-3 min-h-[72px] max-h-[200px]' : 'p-5 min-h-[90px] max-h-[400px]'} text-caption resize-none focus:outline-none placeholder:text-silver leading-relaxed`}
        rows={isCompact ? 2 : 3}
      />

      <div className={`flex items-center justify-between ${isCompact ? 'px-3 py-2' : 'px-4 py-3'} rounded-b-container relative`}>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            className={`${isCompact ? 'p-1.5' : 'p-2'} text-stone hover:text-pure-black rounded-interactive hover:bg-light-gray/50 transition-colors shrink-0`}
            title="Add Attachment"
            onClick={onAttachClick}
          >
            <Paperclip className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </button>

          {hasImages && (
            <div className="flex items-center bg-light-gray/60 p-0.5 rounded-interactive border border-light-gray/50 relative">
              <div className="relative group/read flex items-center">
                <button
                  type="button"
                  className={`text-[11px] px-2.5 py-1 rounded-interactive transition-all font-medium relative focus:outline-none`}
                  onClick={() => {
                    if (!isVisionMode) handleToggleVision();
                  }}
                >
                  {isVisionMode && (
                    <motion.div
                      layoutId="visionTogglePill"
                      className="absolute inset-0 bg-pure-black rounded-interactive shadow-sm"
                      transition={{ type: "spring", stiffness: 500, damping: 35 }}
                    />
                  )}
                  <span className={`relative z-10 transition-colors duration-200 ${isVisionMode ? 'text-pure-white' : 'text-stone hover:text-pure-black'}`}>
                    Read Images
                  </span>
                </button>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-pure-white border border-light-gray text-pure-black text-[11px] rounded-interactive shadow-[0_4px_12px_rgba(0,0,0,0.08)] opacity-0 pointer-events-none group-hover/read:opacity-100 transition-opacity duration-150 whitespace-nowrap z-[60] flex flex-col gap-0.5 items-center">
                  <span className="font-medium">Images will be analyzed by the AI model</span>
                  <span className="text-[10px] text-stone">Requires a vision-capable model</span>
                  <div className="absolute -bottom-[5px] left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-pure-white border-b border-r border-light-gray rotate-45" />
                </div>
              </div>
              
              <div className="relative group/file flex items-center">
                <button
                  type="button"
                  className={`text-[11px] px-2.5 py-1 rounded-interactive transition-all font-medium relative focus:outline-none`}
                  onClick={() => {
                    if (isVisionMode) handleToggleVision();
                  }}
                >
                  {!isVisionMode && (
                    <motion.div
                      layoutId="visionTogglePill"
                      className="absolute inset-0 bg-pure-black rounded-interactive shadow-sm"
                      transition={{ type: "spring", stiffness: 500, damping: 35 }}
                    />
                  )}
                  <span className={`relative z-10 transition-colors duration-200 ${!isVisionMode ? 'text-pure-white' : 'text-stone hover:text-pure-black'}`}>
                    As Files
                  </span>
                </button>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-pure-white border border-light-gray text-pure-black text-[11px] rounded-interactive shadow-[0_4px_12px_rgba(0,0,0,0.08)] opacity-0 pointer-events-none group-hover/file:opacity-100 transition-opacity duration-150 whitespace-nowrap z-[60] flex flex-col items-center">
                  <span className="font-medium">Images will be sent as file attachments only</span>
                  <div className="absolute -bottom-[5px] left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-pure-white border-b border-r border-light-gray rotate-45" />
                </div>
              </div>
            </div>
          )}

          <ModelSelectorMenu
            modelSelector={modelSelector}
            selectedModelValue={selectedModelValue}
            selectedModelLabel={selectedModelLabel}
            onModelChange={onModelChange}
            isSettingModel={isSettingModel}
            isCompact={isCompact}
            isOpen={isModelMenuOpen}
            setIsOpen={setIsModelMenuOpen}
          />

          <ModeSelectorMenu
            activeModeState={activeModeState}
            selectedModeValue={selectedModeValue}
            selectedModeLabel={selectedModeLabel}
            onModeChange={onModeChange}
            isSettingMode={isSettingMode}
            isCompact={isCompact}
            isOpen={isModeMenuOpen}
            setIsOpen={setIsModeMenuOpen}
          />
        </div>

        {isBusy ? (
          <button
            type="button"
            className={`${isCompact ? 'p-1.5' : 'p-2.5'} rounded-interactive shrink-0 flex items-center justify-center bg-light-gray text-pure-black hover:bg-mid-gray transition-colors`}
            onClick={onStop}
          >
            <Square className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </button>
        ) : (
          <button
            type="button"
            className={`${isCompact ? 'p-1.5' : 'p-2.5'} rounded-interactive transition-colors shrink-0 flex items-center justify-center ${canSend ? 'bg-pure-black text-pure-white' : 'bg-light-gray text-silver'}`}
            disabled={!canSend}
            onClick={onSend}
          >
            <ArrowUp className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </button>
        )}
      </div>
    </div>
  );
}
