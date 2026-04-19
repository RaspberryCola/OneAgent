import { motion } from 'framer-motion';
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from 'react';
import type { AttachmentState, ModelSelectorState } from '../../hooks';
import type * as Types from '../../lib/backend/types';
import { Composer } from '../../components/composer/Composer';
import { WorkspaceDropdown } from '../../components/ui/WorkspaceDropdown';

interface HomeScreenProps {
  workspaces: Types.Workspace[];
  activeWorkspace: Types.Workspace | null;
  activeAgent: Types.AgentProfile | null;
  activeAgentProfileId: string | null;
  agentProfiles: Types.AgentProfile[];
  availableAgentsCount: number;
  isWorkspaceLocked: boolean;
  input: string;
  setInput: (value: string) => void;
  attachmentStates: AttachmentState[];
  modelSelector: ModelSelectorState | null;
  selectedModelValue: string | null;
  selectedModelLabel: string | null;
  isSettingModel: boolean;
  selectedModeValue: string | null;
  selectedModeLabel: string | null;
  isSettingMode: boolean;
  activeModeState: Types.AcpSessionModeState | null;
  canSend: boolean;
  isBusy: boolean;
  renderAgentLogo: (agent: Types.AgentProfile, className: string) => ReactNode;
  onSelectWorkspace: (workspace: Types.Workspace) => void;
  onAddWorkspace: () => void;
  onSelectAgentProfile: (profileId: string) => void;
  onModelChange: (value: string) => void;
  onModeChange: (value: string) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemoveAttachment: (id: string) => void;
  onSetAttachmentUsageIntent: (id: string, usageIntent: 'vision_input' | 'file_resource') => void;
  onSend: () => void;
  onStop: () => void;
  onAttachClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function HomeScreen({
  workspaces,
  activeWorkspace,
  activeAgent,
  activeAgentProfileId,
  agentProfiles,
  availableAgentsCount,
  isWorkspaceLocked,
  input,
  setInput,
  attachmentStates,
  modelSelector,
  selectedModelValue,
  selectedModelLabel,
  isSettingModel,
  selectedModeValue,
  selectedModeLabel,
  isSettingMode,
  activeModeState,
  canSend,
  isBusy,
  renderAgentLogo,
  onSelectWorkspace,
  onAddWorkspace,
  onSelectAgentProfile,
  onModelChange,
  onModeChange,
  onDrop,
  onPaste,
  onRemoveAttachment,
  onSetAttachmentUsageIntent,
  onSend,
  onStop,
  onAttachClick,
  onKeyDown,
}: HomeScreenProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 pb-32 w-full max-w-3xl mx-auto overflow-y-auto overflow-x-hidden">
      <div className="flex flex-col items-center mb-10 gap-8 w-full">
        <WorkspaceDropdown
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          onSelectWorkspace={onSelectWorkspace}
          onAddWorkspace={onAddWorkspace}
          disabled={isWorkspaceLocked}
        />
        <div className="flex flex-wrap items-center justify-center gap-2.5 w-full max-w-[768px]">
          {agentProfiles.map((profile) => {
            const isActive = activeAgentProfileId === profile.id;
            return (
              <motion.button
                layout
                initial={false}
                key={profile.id}
                onClick={() => onSelectAgentProfile(profile.id)}
                className={`relative flex items-center justify-center rounded-pill transition-colors border ${
                  isActive
                    ? 'border-pure-black text-pure-white px-4 h-[42px]'
                    : 'border-light-gray bg-pure-white text-near-black hover:bg-snow hover:border-border-light w-[42px] h-[42px]'
                }`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                transition={{ type: 'spring', stiffness: 500, damping: 35 }}
              >
                {isActive && (
                  <motion.div
                    layoutId="activeAgentPill"
                    className="absolute inset-0 bg-pure-black rounded-pill"
                    initial={false}
                    transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                  />
                )}
                <motion.div layout className="relative z-10 flex items-center gap-2.5">
                  {renderAgentLogo(
                    profile,
                    `w-5 h-5 object-contain shrink-0 transition-all duration-200 ${
                      isActive ? 'brightness-0 invert' : 'grayscale opacity-60 hover:opacity-100'
                    }`,
                  )}
                  {isActive && (
                    <motion.span layout className="font-medium text-[15px] whitespace-nowrap">
                      {profile.name}
                    </motion.span>
                  )}
                </motion.div>
              </motion.button>
            );
          })}
        </div>
        {availableAgentsCount === 0 && (
          <div className="text-small text-stone text-center max-w-xl">
            No available agent is ready yet. Claude Code can run from the bundled bridge when resources are present, or native ACP agents can be detected from your PATH.
          </div>
        )}
      </div>
      <div className="w-full flex">
        <div className="flex-1 min-w-0">
          <div className="max-w-[768px] mx-auto px-4 md:px-6">
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
              isCompact={false}
              isBusy={isBusy}
              onStop={onStop}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
