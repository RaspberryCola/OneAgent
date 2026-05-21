import { ArrowDown } from 'lucide-react';
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject } from 'react';
import type { AttachmentState, ModelSelectorState } from '../../hooks';
import type * as Types from '../../lib/backend/types';
import type { TimelineItem } from '../../lib/utils';
import { Composer } from '../../components/composer/Composer';
import { PermissionDisplay } from '../../components/chat/PermissionDisplay';
import { ThoughtDisplay } from '../../components/chat/ThoughtDisplay';
import { ToolCallDisplay } from '../../components/chat/ToolCallDisplay';
import { TimelineMessage } from '../../components/timeline/TimelineMessage';
import { PlanMessage } from '../../components/timeline/PlanMessage';

interface PermissionRequestMeta {
  toolKind?: string;
  title?: string;
  paths?: string[];
  rawInput?: any;
}

interface ConversationScreenProps {
  setScrollAreaRef: (node: HTMLDivElement | null) => void;
  scrollContentRef: RefObject<HTMLDivElement>;
  activeTimeline: Types.TimelineResponse | null;
  activeTimelineItems: TimelineItem[];
  lastAgentMessageIdsPerTurn: Map<string, string>;
  permissionDecisions: Types.PermissionDecision[];
  permissionRequestMeta: Map<string, PermissionRequestMeta>;
  showScrollButton: boolean;
  scrollToBottom: () => void;
  getLatestPermissionDecision: (
    toolCallId: string,
    decisions: Types.PermissionDecision[],
  ) => Types.PermissionDecision | null;
  input: string;
  setInput: (value: string) => void;
  attachmentStates: AttachmentState[];
  activeAgent: Types.AgentProfile | null;
  modelSelector: ModelSelectorState | null;
  selectedModelValue: string | null;
  selectedModelLabel: string | null;
  isSettingModel: boolean;
  activeModeState: Types.AcpSessionModeState | null;
  selectedModeValue: string | null;
  selectedModeLabel: string | null;
  isSettingMode: boolean;
  canSend: boolean;
  isBusy: boolean;
  onModelChange: (value: string) => void;
  onModeChange: (value: string) => void;
  onAttachClick: () => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onSetAttachmentUsageIntent: (id: string, usageIntent: 'vision_input' | 'file_resource') => void;
  onSend: () => void;
  onStop: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  availableCommands?: Types.AvailableCommand[];
}

export function ConversationScreen({
  setScrollAreaRef,
  scrollContentRef,
  activeTimeline,
  activeTimelineItems,
  lastAgentMessageIdsPerTurn,
  permissionDecisions,
  permissionRequestMeta,
  showScrollButton,
  scrollToBottom,
  getLatestPermissionDecision,
  input,
  setInput,
  attachmentStates,
  activeAgent,
  modelSelector,
  selectedModelValue,
  selectedModelLabel,
  isSettingModel,
  activeModeState,
  selectedModeValue,
  selectedModeLabel,
  isSettingMode,
  canSend,
  isBusy,
  onModelChange,
  onModeChange,
  onAttachClick,
  onDrop,
  onPaste,
  onRemoveAttachment,
  onSetAttachmentUsageIntent,
  onSend,
  onStop,
  onKeyDown,
  availableCommands,
}: ConversationScreenProps) {
  const planItems = activeTimelineItems.filter(
    (item) => item.type === 'message' && item.data.kind === 'plan'
  );
  const latestPlanMessage = planItems.length > 0 ? planItems[planItems.length - 1].data as any : null;

  return (
    <div
      ref={setScrollAreaRef}
      className="relative flex-1 overflow-y-auto min-w-0 w-full flex flex-col scroll-smooth scrollbar-chat"
    >
      <div ref={scrollContentRef} className="max-w-[768px] mx-auto w-full flex-1 flex flex-col min-h-full">
        <div className="flex-1 space-y-4 px-4 md:px-6 pt-4 pb-4">
          {activeTimelineItems.map((item) => {
            if (item.type === 'message') {
              const message = item.data;
              if (message.kind === 'thinking') {
                return (
                  <ThoughtDisplay
                    key={message.id}
                    content={message.content_json?.text || ''}
                    status={message.content_json?.status || 'done'}
                    duration_ms={message.content_json?.duration_ms}
                  />
                );
              }
              return (
                <TimelineMessage
                  key={message.id}
                  message={message}
                  terminals={activeTimeline?.terminals ?? []}
                  lastAgentMessageIdsPerTurn={lastAgentMessageIdsPerTurn}
                />
              );
            }

            if (item.type === 'tool_call') {
              return (
                <ToolCallDisplay
                  key={item.key}
                  toolCall={item.data}
                  terminals={(activeTimeline?.terminals ?? []).filter((terminal) =>
                    Array.isArray(item.data.terminal_ids_json) && item.data.terminal_ids_json.includes(terminal.terminal_id),
                  )}
                  permissionDecision={getLatestPermissionDecision(item.data.tool_call_id, permissionDecisions)}
                />
              );
            }

            return null;
          })}
        </div>
        <div className="sticky bottom-0 bg-pure-white z-10 pb-4 md:pb-6 px-4 md:px-6">
          {activeTimelineItems
            .filter(
              (
                item,
              ): item is Extract<TimelineItem, { type: 'permission' }> =>
                item.type === 'permission' && item.data.status === 'pending',
            )
            .map((item) => (
              <div key={item.key} className="mb-4 flex w-full justify-center">
                <div className="w-full">
                  <PermissionDisplay
                    request={item.data}
                    toolCall={
                      (activeTimeline?.tool_calls ?? []).find(
                        (toolCall) => toolCall.tool_call_id === item.data.tool_call_id,
                      ) ?? null
                    }
                    requestMeta={
                      permissionRequestMeta.get(item.data.id)
                      ?? permissionRequestMeta.get(item.data.tool_call_id)
                      ?? null
                    }
                    decision={getLatestPermissionDecision(item.data.tool_call_id, permissionDecisions)}
                  />
                </div>
              </div>
            ))}
          <div className="relative">
            {latestPlanMessage && (
              <div className="mb-2">
                <PlanMessage entries={Array.isArray(latestPlanMessage.content_json?.entries) ? latestPlanMessage.content_json.entries : []} />
              </div>
            )}
            {showScrollButton && (
              <div className="pointer-events-none absolute left-1/2 bottom-full z-20 mb-3 -translate-x-1/2">
                <button
                  type="button"
                  onClick={scrollToBottom}
                  className="pointer-events-auto p-2 rounded-full bg-pure-white border border-light-gray text-stone hover:text-pure-black hover:bg-light-gray shadow-sm transition-colors cursor-pointer"
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              </div>
            )}
            <Composer
              input={input}
              setInput={setInput}
              attachments={attachmentStates}
              activeAgent={activeAgent}
              modelSelector={modelSelector}
              selectedModelValue={selectedModelValue}
              selectedModelLabel={selectedModelLabel}
              onModelChange={(value) => onModelChange(String(value))}
              isSettingModel={isSettingModel}
              activeModeState={activeModeState}
              selectedModeValue={selectedModeValue}
              selectedModeLabel={selectedModeLabel}
              onModeChange={(value) => onModeChange(String(value))}
              isSettingMode={isSettingMode}
              onAttachClick={onAttachClick}
              onDrop={onDrop}
              onPaste={onPaste}
              onRemoveAttachment={onRemoveAttachment}
              onSetAttachmentUsageIntent={onSetAttachmentUsageIntent}
              onSend={onSend}
              onKeyDown={onKeyDown}
              canSend={canSend}
              isCompact
              isBusy={isBusy}
              onStop={onStop}
              availableCommands={availableCommands}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
