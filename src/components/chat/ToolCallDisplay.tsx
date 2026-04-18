import React, { useState } from 'react';
import { CollapsibleContent } from '../ui/CollapsibleContent';
import type { ToolCallProjection, TerminalRecord, PermissionDecision } from '../../lib/backend/types';
import { DISPLAY_LIMITS } from '../../lib/constants';

interface ToolCallDisplayProps {
  toolCall: ToolCallProjection;
  terminals: TerminalRecord[];
  permissionDecision?: PermissionDecision | null;
}

// Shared permission decision configuration (single source of truth for labels and icons)
const PERMISSION_DECISION_CONFIG: Record<string, { label: string; icon: 'check' | 'x' | null }> = {
  allow_once: { label: 'Allowed once', icon: 'check' },
  allow_always: { label: 'Always allowed', icon: 'check' },
  reject_once: { label: 'Rejected once', icon: 'x' },
  reject_always: { label: 'Always rejected', icon: 'x' },
  cancelled: { label: 'Cancelled', icon: 'x' },
};

// Helper: get permission decision config
function getPermissionDecisionConfig(decision: string) {
  return PERMISSION_DECISION_CONFIG[decision] || { label: null, icon: null };
}

// Helper: safely get string value with type check
function getStringVal(obj: any, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

// Helper: extract human-readable input summary from raw_input_json
function extractInputSummary(rawInput: any): string {
  if (!rawInput) return '';
  if (typeof rawInput === 'string') return rawInput;

  // Try common input field patterns
  if (rawInput.command) {
    const args = Array.isArray(rawInput.args) ? rawInput.args.join(' ') : (typeof rawInput.args === 'string' ? rawInput.args : '');
    return `${rawInput.command}${args ? ` ${args}` : ''}`;
  }
  const path = getStringVal(rawInput, 'path');
  if (path) return path;
  const content = getStringVal(rawInput, 'content');
  if (content) return content.slice(0, DISPLAY_LIMITS.MAX_CONTENT_PREVIEW);
  const text = getStringVal(rawInput, 'text');
  if (text) return text.slice(0, DISPLAY_LIMITS.MAX_CONTENT_PREVIEW);
  const query = getStringVal(rawInput, 'query');
  if (query) return query.slice(0, DISPLAY_LIMITS.MAX_CONTENT_PREVIEW);
  const file = getStringVal(rawInput, 'file');
  if (file) return file;

  // Fallback: stringify and truncate
  const str = JSON.stringify(rawInput, null, 2);
  return str.length > DISPLAY_LIMITS.MAX_JSON_PREVIEW ? str.slice(0, DISPLAY_LIMITS.MAX_JSON_PREVIEW) + '...' : str;
}

// Helper: build concise parameter summary based on tool kind
function buildParamSummary(kind: string, rawInput: any): string | undefined {
  if (!rawInput || typeof rawInput !== 'object') return undefined;

  // Read/Edit → show file path
  if (kind === 'read' || kind === 'edit' || kind === 'write') {
    return getStringVal(rawInput, 'file_path') || getStringVal(rawInput, 'path') || getStringVal(rawInput, 'fileName');
  }
  // Execute → show command
  if (kind === 'execute' || kind === 'execute_command') {
    return getStringVal(rawInput, 'command');
  }
  // Search/Grep → show pattern + path
  if (kind === 'search' || kind === 'grep') {
    const parts: string[] = [];
    const pattern = getStringVal(rawInput, 'pattern');
    if (pattern) parts.push(`"${pattern}"`);
    const searchPath = getStringVal(rawInput, 'path');
    if (searchPath) parts.push(`in ${searchPath}`);
    else {
      const glob = getStringVal(rawInput, 'glob');
      if (glob) parts.push(`in ${glob}`);
    }
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  // Glob → show pattern
  if (kind === 'glob') {
    const parts: string[] = [];
    const pattern = getStringVal(rawInput, 'pattern');
    if (pattern) parts.push(pattern);
    const globPath = getStringVal(rawInput, 'path');
    if (globPath) parts.push(`in ${globPath}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  // Fallback: pick first meaningful field
  for (const key of ['file_path', 'command', 'path', 'pattern', 'query', 'url', 'content']) {
    const val = getStringVal(rawInput, key);
    if (val) {
      return val.length > DISPLAY_LIMITS.MAX_PARAM_PREVIEW ? val.slice(0, DISPLAY_LIMITS.MAX_PARAM_PREVIEW) + '...' : val;
    }
  }
  return undefined;
}

// Helper: extract human-readable output summary
function extractOutputSummary(rawOutput: any): string | null {
  if (!rawOutput) return null;
  if (typeof rawOutput === 'string') return rawOutput;

  // Try text field (from our enhanced extraction)
  if (rawOutput.text) return String(rawOutput.text);
  if (rawOutput.output) return String(rawOutput.output);

  return null;
}

// Status indicator component (minimal, grayscale)
// Uses shared PERMISSION_DECISION_CONFIG for consistent icon mapping
function StatusDot({ status, permissionDecision }: { status: string; permissionDecision?: PermissionDecision | null }) {
  const statusLower = status.toLowerCase();

  // If there's a permission decision, use shared config for icon
  if (permissionDecision) {
    const config = getPermissionDecisionConfig(permissionDecision.decision);
    
    if (config.icon === 'check') {
      return (
        <svg className="w-3 h-3 shrink-0 text-stone" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 6L5 8.5L9.5 3.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    }
    
    if (config.icon === 'x') {
      return (
        <svg className="w-3 h-3 shrink-0 text-near-black" viewBox="0 0 12 12" fill="none">
          <path
            d="M3 3L9 9M9 3L3 9"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );
    }
  }

  // Map status to visual state
  const isRunning = statusLower === 'running' || statusLower === 'declared' || statusLower === 'in_progress';
  const isCompleted = statusLower === 'completed' || statusLower === 'success';
  const isFailed = statusLower === 'failed' || statusLower === 'error';

  // Failed: show X icon
  if (isFailed) {
    return (
      <svg className="w-3 h-3 shrink-0 text-near-black" viewBox="0 0 12 12" fill="none">
        <path
          d="M3 3L9 9M9 3L3 9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  // Running: pulse dot
  if (isRunning) {
    return (
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-silver animate-pulse" />
    );
  }

  // Completed: checkmark icon
  if (isCompleted) {
    return (
      <svg className="w-3 h-3 shrink-0 text-stone" viewBox="0 0 12 12" fill="none">
        <path
          d="M2.5 6L5 8.5L9.5 3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  // Default/Pending: light gray dot
  return (
    <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-light-gray" />
  );
}

// Expand arrow icon component
function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg 
      className={`w-3 h-3 shrink-0 text-silver transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} 
      viewBox="0 0 12 12" 
      fill="none"
    >
      <path 
        d="M4.5 2.5L8 6L4.5 9.5" 
        stroke="currentColor" 
        strokeWidth="1.5" 
        strokeLinecap="round" 
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ToolCallDisplay({ toolCall, terminals, permissionDecision }: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const status = toolCall.status.toLowerCase();
  const isRunning = status === "running" || status === "declared" || status === "in_progress";

  // Compute summaries directly (lightweight operations, no memoization needed)
  const inputSummary = extractInputSummary(toolCall.raw_input_json);
  const paramSummary = buildParamSummary(toolCall.kind, toolCall.raw_input_json);
  const outputSummary = extractOutputSummary(toolCall.raw_output_json);

  // Use param summary if available, fallback to input summary
  const displaySummary = paramSummary || inputSummary;

  const hasInput = Boolean(toolCall.raw_input_json && Object.keys(toolCall.raw_input_json || {}).length > 0);
  const hasOutput = Boolean(outputSummary || (toolCall.raw_output_json && Object.keys(toolCall.raw_output_json || {}).length > 0));
  const hasDetail = hasInput || hasOutput || terminals.length > 0;

  const toolTitle = toolCall.title || toolCall.kind;

  // Permission decision label - uses shared PERMISSION_DECISION_CONFIG
  const permissionLabel = permissionDecision ? getPermissionDecisionConfig(permissionDecision.decision).label : null;

  return (
    <div className="flex w-full justify-start mt-0.5 mb-1">
      <div className="flex flex-col gap-1 min-w-0 w-full max-w-[95%] md:max-w-[85%]">
        <button
          onClick={() => hasDetail && setIsExpanded(!isExpanded)}
          className={`flex items-center gap-2 group bg-transparent border-none p-0 text-left ${hasDetail ? 'cursor-pointer' : 'cursor-default'}`}
        >
          {/* Status indicator */}
          <StatusDot status={toolCall.status} permissionDecision={permissionDecision} />

          {/* Tool title */}
          <span className="text-[12px] font-mono text-stone group-hover:text-pure-black transition-colors truncate">
            {toolTitle}
          </span>

          {/* Permission decision label (if exists) */}
          {permissionLabel && (
            <span className="text-[10px] font-mono text-silver shrink-0">
              · {permissionLabel}
            </span>
          )}

          {/* Parameter summary - show alongside permission label if space allows */}
          {displaySummary && (
            <span className="text-[11px] font-mono text-silver truncate max-w-[40%] md:max-w-[50%]">
              {displaySummary}
            </span>
          )}

          {/* Expand arrow (only if has detail) */}
          {hasDetail && (
            <ExpandIcon expanded={isExpanded} />
          )}
        </button>

        {isExpanded && hasDetail && (
          <div className="pl-3 border-l border-light-gray/50 ml-1.5 w-full space-y-3 mt-1">
            {hasInput && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wide text-silver mb-1">Input</div>
                <CollapsibleContent maxHeight={150}>
                  <pre className="text-[11px] font-mono text-stone whitespace-pre-wrap break-words bg-snow rounded-container px-2 py-1.5">
                    {typeof toolCall.raw_input_json === 'string'
                      ? toolCall.raw_input_json
                      : JSON.stringify(toolCall.raw_input_json, null, 2)}
                  </pre>
                </CollapsibleContent>
              </div>
            )}

            {hasOutput && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-wide text-silver mb-1">Output</div>
                <CollapsibleContent maxHeight={300}>
                  <pre className="text-[11px] font-mono text-stone whitespace-pre-wrap break-words bg-snow rounded-container px-2 py-1.5">
                    {typeof toolCall.raw_output_json === 'string'
                      ? toolCall.raw_output_json
                      : JSON.stringify(toolCall.raw_output_json, null, 2)}
                  </pre>
                </CollapsibleContent>
              </div>
            )}

            {terminals.length > 0 && (
              <div className="space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-wide text-silver">Terminal</div>
                {terminals.map((terminal) => (
                  <div key={terminal.id}>
                    <div className="text-[11px] font-mono text-stone">
                      $ {terminal.command} {Array.isArray(terminal.args_json) ? terminal.args_json.join(" ") : ""}
                    </div>
                    {(terminal.stdout_buffer || terminal.stderr_buffer) && (
                      <CollapsibleContent maxHeight={400}>
                        <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-words text-stone bg-snow rounded-container px-2 py-1.5">
                          {terminal.stdout_buffer || terminal.stderr_buffer}
                        </pre>
                      </CollapsibleContent>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
