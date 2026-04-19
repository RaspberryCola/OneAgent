import { useRef, useState } from 'react';
import { ArrowUp, Paperclip, Square } from 'lucide-react';
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
            className={`${isCompact ? 'p-1.5' : 'p-2'} text-stone hover:text-pure-black rounded-pill hover:bg-light-gray/50 transition-colors shrink-0`}
            title="Add Attachment"
            onClick={onAttachClick}
          >
            <Paperclip className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </button>

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
            className={`${isCompact ? 'p-1.5' : 'p-2.5'} rounded-pill shrink-0 flex items-center justify-center bg-light-gray text-pure-black hover:bg-mid-gray transition-colors`}
            onClick={onStop}
          >
            <Square className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
          </button>
        ) : (
          <button
            type="button"
            className={`${isCompact ? 'p-1.5' : 'p-2.5'} rounded-pill transition-colors shrink-0 flex items-center justify-center ${canSend ? 'bg-pure-black text-pure-white' : 'bg-light-gray text-silver'}`}
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
